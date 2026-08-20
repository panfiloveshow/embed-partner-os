import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma, TaskStatus } from "@prisma/client";
import type {
  ContactRegistryItem,
  HealthCheckView,
  OrganizationGroupView,
  PartnerAuditView,
  PartnerCardPayload,
  PartnerExportAuditView,
  PartnerIntegrationStatus,
  PartnerMetricView,
  PartnerRegistryItem,
  PartnerRegistryPayload,
  PlacementAlertView,
  PlacementView,
} from "@embed-os/contracts";
import {
  PARTNER_EXPORT_PERMISSION,
  ExportPermissionDeniedError,
  createPartnerExport,
  resolveExportActor,
} from "../application/partner-export.js";
import type { PartnerPort, PartnerRegistryQuery } from "../partner.port.js";
import { PartnerNotFoundError } from "../partner.service.js";
import {
  organizationScope,
  PersistenceActorService,
  type PersistenceActor,
} from "./persistence-actor.service.js";
import { PrismaService } from "./prisma.service.js";

@Injectable()
export class PostgresPartnerService implements PartnerPort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PersistenceActorService) private readonly actors: PersistenceActorService,
  ) {}

  async listPartners(query: PartnerRegistryQuery = {}): Promise<PartnerRegistryPayload> {
    const actor = await this.actors.current();
    const { now, allPartners, partners } = await this.loadPartnersForActor(query, actor);
    return {
      generatedAt: now.toISOString(),
      teamName: scopeName(actor),
      total: partners.length,
      truncated: partners.length > PARTNER_PAGE_LIMIT,
      filters: registryFilters(allPartners),
      partners: partners.slice(0, PARTNER_PAGE_LIMIT),
    };
  }

  private async loadPartnersForActor(query: PartnerRegistryQuery, actor: PersistenceActor) {
    const now = new Date();
    const records = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        ...organizationScope(actor),
        ...(query.search
          ? {
              AND: [
                {
                  OR: [
                    { name: { contains: query.search, mode: "insensitive" } },
                    { legalName: { contains: query.search, mode: "insensitive" } },
                    { segment: { contains: query.search, mode: "insensitive" } },
                    {
                      group: {
                        is: {
                          archivedAt: null,
                          name: { contains: query.search, mode: "insensitive" },
                        },
                      },
                    },
                    {
                      domains: {
                        some: {
                          archivedAt: null,
                          hostNormalized: { contains: query.search, mode: "insensitive" },
                        },
                      },
                    },
                  ],
                },
              ],
            }
          : {}),
        ...(query.groupId
          ? {
              groupId: query.groupId,
              group: { is: { archivedAt: null } },
            }
          : {}),
        ...(query.segment ? { segment: query.segment } : {}),
        ...(query.ownerId ? { ownerId: query.ownerId } : {}),
        ...(query.stageCode || query.scoreMin !== undefined || query.scoreMax !== undefined
          ? {
              opportunities: {
                some: {
                  archivedAt: null,
                  ...(query.stageCode ? { stageCode: query.stageCode } : {}),
                  ...(query.scoreMin !== undefined || query.scoreMax !== undefined
                    ? {
                        score: {
                          ...(query.scoreMin !== undefined ? { gte: query.scoreMin } : {}),
                          ...(query.scoreMax !== undefined ? { lte: query.scoreMax } : {}),
                        },
                      }
                    : {}),
                },
              },
            }
          : {}),
      },
      include: partnerOrganizationRelations,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const allPartners = records.map((record) => mapPartner(record));
    const partners = allPartners
      .filter(
        (partner) =>
          !query.integrationStatus || partner.integrationStatus === query.integrationStatus,
      )
      .filter(
        (partner) =>
          !query.activeAfter ||
          (partner.lastActivityAt !== null && partner.lastActivityAt >= query.activeAfter),
      )
      .sort(
        (left, right) =>
          (right.partnerScore ?? -1) - (left.partnerScore ?? -1) ||
          left.name.localeCompare(right.name, "ru"),
      );

    return { now, allPartners, partners };
  }

  async getPartner(organizationId: string): Promise<PartnerCardPayload> {
    const now = new Date();
    const actor = await this.actors.current();
    const record = await this.prisma.organization.findFirst({
      where: {
        id: organizationId,
        archivedAt: null,
        ...organizationScope(actor),
      },
      include: partnerOrganizationRelations,
    });
    if (!record) throw new PartnerNotFoundError(organizationId);
    const organization = mapPartner(record);
    const opportunityIds = record.opportunities.map(({ id }) => id);
    const taskIds = record.opportunities.flatMap(({ tasks }) => tasks.map(({ id }) => id));
    const placementIds = record.placements.map(({ id }) => id);
    const contactIds = record.contactLinks.map(({ contactId }) => contactId);
    const auditRecords = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: "Organization", entityId: organizationId },
          ...(opportunityIds.length
            ? [{ entityType: "Opportunity", entityId: { in: opportunityIds } }]
            : []),
          ...(taskIds.length ? [{ entityType: "Task", entityId: { in: taskIds } }] : []),
          ...(placementIds.length
            ? [{ entityType: "Placement", entityId: { in: placementIds } }]
            : []),
          ...(contactIds.length ? [{ entityType: "Contact", entityId: { in: contactIds } }] : []),
        ],
      },
      include: { actor: { select: { displayName: true } } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    const contacts = record.contactLinks.map(({ contact, ...link }) =>
      mapContact(contact, link, record.name),
    );
    const interactions = record.opportunities
      .flatMap(({ interactions }) => interactions)
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
      .map((interaction) => ({
        id: interaction.id,
        type: interaction.type,
        occurredAt: interaction.occurredAt.toISOString(),
        contactName: interaction.contact?.fullName ?? null,
        authorName: interaction.author.displayName,
        outcome: interaction.outcome,
        summary: interaction.summary,
        source: interaction.source,
      }));
    const tasks = record.opportunities
      .flatMap((opportunity) => opportunity.tasks.map((task) => ({ opportunity, task })))
      .sort((left, right) => left.task.dueAt.getTime() - right.task.dueAt.getTime())
      .map(({ opportunity, task }) => ({
        id: task.id,
        opportunityId: opportunity.id,
        title: task.title,
        dueAt: task.dueAt.toISOString(),
        status: task.status,
        ownerName: task.owner.displayName,
        outcome: task.outcome,
      }));
    const opportunities = record.opportunities.map((opportunity) => ({
      id: opportunity.id,
      type: opportunity.type,
      stageCode: opportunity.stageCode,
      stageLabel: opportunity.stageLabel,
      status: opportunity.status,
      score: opportunity.score,
      owner: { id: opportunity.owner.id, name: opportunity.owner.displayName },
      nextAction:
        opportunity.nextTask?.status === TaskStatus.OPEN
          ? {
              id: opportunity.nextTask.id,
              title: opportunity.nextTask.title,
              dueAt: opportunity.nextTask.dueAt.toISOString(),
            }
          : null,
      updatedAt: opportunity.updatedAt.toISOString(),
    }));
    return {
      generatedAt: now.toISOString(),
      summary: partnerSummary(organization),
      organization,
      organizationGroup: mapOrganizationGroup(record.group, actor),
      contacts,
      opportunities,
      interactions,
      tasks,
      placements: record.placements.map(mapPlacement),
      metrics: partnerMetrics(organization, now),
      documents: [],
      audit: auditRecords.map(mapAudit),
    };
  }

  async exportPartners(query: PartnerRegistryQuery, rawActorSubject: string) {
    const actor = await this.exportActor(rawActorSubject);
    const persistenceActor = await this.actors.current();
    const { partners, now } = await this.loadPartnersForActor(query, persistenceActor);
    const result = createPartnerExport(partners, query, actor.subject, randomUUID(), now);
    await this.prisma.auditLog.create({
      data: {
        id: result.audit.id,
        actorId: actor.id,
        action: "partner.registry.export",
        entityType: "PartnerRegistryExport",
        entityId: result.audit.id,
        beforeJson: Prisma.JsonNull,
        afterJson: result.audit as unknown as Prisma.InputJsonValue,
        occurredAt: now,
      },
    });
    return result;
  }

  async listPartnerExportAudit(rawActorSubject: string): Promise<PartnerExportAuditView[]> {
    const actor = await this.exportActor(rawActorSubject);
    const persistenceActor = await this.actors.current();
    const records = await this.prisma.auditLog.findMany({
      where: {
        action: "partner.registry.export",
        entityType: "PartnerRegistryExport",
        ...(persistenceActor.scopeMode === "all"
          ? {}
          : persistenceActor.scopeMode === "team"
            ? { actor: { teamId: actor.teamId } }
            : { actorId: actor.id }),
      },
      select: { afterJson: true },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    return records.flatMap(({ afterJson }) => {
      const audit = parseExportAudit(afterJson);
      return audit ? [audit] : [];
    });
  }

  private async exportActor(rawActorSubject: string) {
    const subject = resolveExportActor(rawActorSubject);
    const user = await this.prisma.user.findUnique({
      where: { externalSubject: subject },
      select: {
        id: true,
        teamId: true,
        status: true,
        permissions: {
          where: { permission: PARTNER_EXPORT_PERMISSION, revokedAt: null },
          select: { permission: true },
          take: 1,
        },
      },
    });
    if (!user || user.status !== "ACTIVE" || !user.teamId || user.permissions.length === 0) {
      throw new ExportPermissionDeniedError();
    }
    return { id: user.id, teamId: user.teamId, subject };
  }
}

const PARTNER_PAGE_LIMIT = 200;

const partnerOrganizationRelations = Prisma.validator<Prisma.OrganizationInclude>()({
  owner: { select: { id: true, displayName: true } },
  group: {
    select: {
      id: true,
      teamId: true,
      name: true,
      version: true,
      archivedAt: true,
      organizations: {
        where: { archivedAt: null },
        select: {
          id: true,
          name: true,
          legalName: true,
          domains: {
            where: { archivedAt: null },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            select: { hostNormalized: true, isPrimary: true },
          },
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      },
    },
  },
  domains: {
    where: { archivedAt: null },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  },
  contactLinks: {
    where: { validTo: null, contact: { archivedAt: null, mergedIntoId: null } },
    include: { contact: true },
    orderBy: [{ isPrimary: "desc" }, { validFrom: "asc" }],
  },
  opportunities: {
    where: { archivedAt: null },
    include: {
      owner: { select: { id: true, displayName: true } },
      nextTask: true,
      tasks: {
        include: { owner: { select: { displayName: true } } },
        orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      },
      interactions: {
        include: {
          contact: { select: { fullName: true } },
          author: { select: { displayName: true } },
        },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      },
    },
    orderBy: [{ score: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
  },
  placements: {
    where: { archivedAt: null },
    include: {
      organization: { select: { name: true } },
      owner: { select: { displayName: true } },
      healthChecks: { orderBy: { checkedAt: "desc" }, take: 1 },
      alerts: { where: { status: "open" }, orderBy: { openedAt: "desc" }, take: 1 },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
});

type PartnerOrganizationRecord = Prisma.OrganizationGetPayload<{
  include: typeof partnerOrganizationRelations;
}>;

function mapPartner(record: PartnerOrganizationRecord): PartnerRegistryItem {
  const primaryOpportunity = record.opportunities[0] ?? null;
  const lastActivityAt = latestDate([
    ...record.opportunities.map(({ updatedAt }) => updatedAt),
    ...record.opportunities.flatMap(({ interactions }) =>
      interactions.map(({ occurredAt }) => occurredAt),
    ),
    ...record.placements.flatMap(({ lastCheckAt }) => (lastCheckAt ? [lastCheckAt] : [])),
  ]);
  return {
    id: record.id,
    version: record.version,
    name: record.name,
    legalName: record.legalName,
    segment: record.segment,
    status: record.status,
    primaryDomain: record.domains[0]?.hostNormalized ?? null,
    domains: record.domains.map((domain) => ({
      id: domain.id,
      host: domain.hostNormalized,
      isPrimary: domain.isPrimary,
      verifiedAt: domain.verifiedAt?.toISOString() ?? null,
    })),
    organizationGroup:
      record.group && record.group.archivedAt === null
        ? { id: record.group.id, name: record.group.name }
        : null,
    owner: record.owner ? { id: record.owner.id, name: record.owner.displayName } : null,
    currentStage: primaryOpportunity
      ? { code: primaryOpportunity.stageCode, label: primaryOpportunity.stageLabel }
      : null,
    partnerScore: primaryOpportunity?.score ?? null,
    integrationStatus: integrationStatus(record),
    lastActivityAt: lastActivityAt?.toISOString() ?? null,
    nextAction:
      primaryOpportunity?.nextTask?.status === TaskStatus.OPEN
        ? {
            id: primaryOpportunity.nextTask.id,
            title: primaryOpportunity.nextTask.title,
            dueAt: primaryOpportunity.nextTask.dueAt.toISOString(),
          }
        : null,
    counts: {
      contacts: record.contactLinks.length,
      opportunities: record.opportunities.length,
      tasks: record.opportunities.reduce(
        (sum, opportunity) =>
          sum + opportunity.tasks.filter(({ status }) => status === TaskStatus.OPEN).length,
        0,
      ),
      placements: record.placements.length,
      documents: 0,
    },
  };
}

function integrationStatus(record: PartnerOrganizationRecord): PartnerIntegrationStatus {
  if (
    record.placements.some(
      (placement) =>
        placement.healthStatus === "failed" ||
        placement.healthStatus === "degraded" ||
        placement.alerts.length > 0,
    )
  )
    return "issue";
  if (record.placements.some(({ businessStatus }) => businessStatus === "active")) return "active";
  if (
    record.placements.some(({ businessStatus }) => businessStatus === "planned") ||
    record.opportunities.some(({ stageCode }) => ["S7", "S8", "S9", "S10"].includes(stageCode))
  )
    return "planned";
  return "not_started";
}

function mapContact(
  contact: PartnerOrganizationRecord["contactLinks"][number]["contact"],
  link: Omit<PartnerOrganizationRecord["contactLinks"][number], "contact">,
  organizationName: string,
): ContactRegistryItem {
  return {
    id: contact.id,
    version: contact.version,
    fullName: contact.fullName,
    email: contact.email,
    phone: contact.phone,
    messenger: contact.messenger,
    source: contact.source,
    verifiedAt: contact.verifiedAt?.toISOString() ?? null,
    restrictions: restrictionNote(contact.restrictions),
    status: "active",
    archivedAt: null,
    mergedIntoId: null,
    updatedAt: contact.updatedAt.toISOString(),
    organizationLinks: [
      {
        id: link.id,
        organizationId: link.organizationId,
        organizationName,
        role: link.role,
        department: link.department,
        isPrimary: link.isPrimary,
        validFrom: link.validFrom.toISOString(),
        validTo: null,
      },
    ],
    duplicateMatches: [],
  };
}

function mapPlacement(record: PartnerOrganizationRecord["placements"][number]): PlacementView {
  const check = record.healthChecks[0];
  const alert = record.alerts[0];
  return {
    id: record.id,
    organizationId: record.organizationId,
    organizationName: record.organization.name,
    opportunityId: record.opportunityId,
    ownerId: record.ownerId,
    ownerName: record.owner.displayName,
    pageUrl: record.pageUrl,
    urlPattern: record.urlPattern,
    embedType: record.embedType as PlacementView["embedType"],
    environment: record.environment as PlacementView["environment"],
    businessStatus: record.businessStatus as PlacementView["businessStatus"],
    healthStatus: record.healthStatus as PlacementView["healthStatus"],
    launchedAt: record.launchedAt?.toISOString() ?? null,
    consecutiveFailures: record.consecutiveFailures,
    firstFailureAt: record.firstFailureAt?.toISOString() ?? null,
    lastSuccessAt: record.lastSuccessAt?.toISOString() ?? null,
    lastCheckAt: record.lastCheckAt?.toISOString() ?? null,
    nextCheckAt: record.nextCheckAt?.toISOString() ?? null,
    version: record.version,
    lastCheck: check
      ? {
          id: check.id,
          placementId: check.placementId,
          checkedAt: check.checkedAt.toISOString(),
          result: check.result as HealthCheckView["result"],
          pageHttpStatus: check.pageHttpStatus,
          embedHttpStatus: check.embedHttpStatus,
          playerFound: check.playerFound,
          embedUrl: check.embedUrl,
          evidenceUri: check.evidenceUri,
          errorCode: check.errorCode,
          durationMs: check.durationMs,
          source: check.source as HealthCheckView["source"],
        }
      : null,
    activeAlert: alert
      ? {
          id: alert.id,
          status: alert.status as PlacementAlertView["status"],
          severity: alert.severity as PlacementAlertView["severity"],
          firstFailureAt: alert.firstFailureAt.toISOString(),
          openedAt: alert.openedAt.toISOString(),
          closedAt: alert.closedAt?.toISOString() ?? null,
          technicalTaskId: alert.technicalTaskId,
        }
      : null,
  };
}

function mapAudit(record: {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  actor: { displayName: string };
}): PartnerAuditView {
  return {
    id: record.id,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    actorName: record.actor.displayName,
    occurredAt: record.occurredAt.toISOString(),
    summary: auditActionLabel(record.action),
  };
}

function registryFilters(partners: PartnerRegistryItem[]): PartnerRegistryPayload["filters"] {
  return {
    groups: uniqueBy(
      partners.flatMap(({ organizationGroup }) => (organizationGroup ? [organizationGroup] : [])),
      ({ id }) => id,
    ).sort((left, right) => left.name.localeCompare(right.name, "ru")),
    segments: [...new Set(partners.flatMap(({ segment }) => (segment ? [segment] : [])))].sort(
      (left, right) => left.localeCompare(right, "ru"),
    ),
    owners: uniqueBy(
      partners.flatMap(({ owner }) => (owner ? [owner] : [])),
      ({ id }) => id,
    ).sort((left, right) => left.name.localeCompare(right.name, "ru")),
    stages: uniqueBy(
      partners.flatMap(({ currentStage }) => (currentStage ? [currentStage] : [])),
      ({ code }) => code,
    ).sort((left, right) => left.code.localeCompare(right.code)),
    integrationStatuses: ["not_started", "planned", "active", "issue"],
  };
}

function mapOrganizationGroup(
  group: PartnerOrganizationRecord["group"],
  actor: PersistenceActor,
): OrganizationGroupView | null {
  if (
    !group ||
    group.archivedAt !== null ||
    actor.scopeMode === "own" ||
    actor.scopeMode === "assigned"
  ) {
    return null;
  }
  if (actor.scopeMode === "team" && group.teamId !== actor.teamId) return null;
  return {
    id: group.id,
    name: group.name,
    version: group.version,
    members: group.organizations.map((member) => ({
      id: member.id,
      name: member.name,
      legalName: member.legalName,
      primaryDomain: member.domains[0]?.hostNormalized ?? null,
      domains: member.domains.map(({ hostNormalized }) => hostNormalized),
    })),
  };
}

function scopeName(actor: PersistenceActor) {
  if (actor.scopeMode === "all") return "Все команды";
  if (actor.scopeMode === "team") return actor.teamName ?? "Моя команда";
  return actor.displayName;
}

function parseExportAudit(value: Prisma.JsonValue | null): PartnerExportAuditView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const audit = value as Prisma.JsonObject;
  if (
    typeof audit.id !== "string" ||
    typeof audit.actorSubject !== "string" ||
    audit.permission !== PARTNER_EXPORT_PERMISSION ||
    typeof audit.generatedAt !== "string" ||
    typeof audit.rowCount !== "number" ||
    typeof audit.fileName !== "string" ||
    typeof audit.checksum !== "string" ||
    !audit.filters ||
    typeof audit.filters !== "object" ||
    Array.isArray(audit.filters)
  )
    return null;
  return {
    id: audit.id,
    actorSubject: audit.actorSubject,
    permission: PARTNER_EXPORT_PERMISSION,
    generatedAt: audit.generatedAt,
    rowCount: audit.rowCount,
    fileName: audit.fileName,
    checksum: audit.checksum,
    filters: audit.filters as PartnerExportAuditView["filters"],
  };
}

function partnerMetrics(organization: PartnerRegistryItem, now: Date): PartnerMetricView[] {
  const dataAsOf = now.toISOString();
  return [
    {
      code: "partner_score",
      label: "Partner Score",
      value: organization.partnerScore ?? 0,
      dataAsOf,
      completeness: organization.partnerScore === null ? "unavailable" : "complete",
    },
    {
      code: "contacts",
      label: "Контакты",
      value: organization.counts.contacts,
      dataAsOf,
      completeness: "complete",
    },
    {
      code: "opportunities",
      label: "Возможности",
      value: organization.counts.opportunities,
      dataAsOf,
      completeness: "complete",
    },
    {
      code: "active_tasks",
      label: "Активные задачи",
      value: organization.counts.tasks,
      dataAsOf,
      completeness: "complete",
    },
    {
      code: "active_placements",
      label: "Размещения",
      value: organization.counts.placements,
      dataAsOf,
      completeness: "complete",
    },
  ];
}

function partnerSummary(partner: PartnerRegistryItem) {
  const domain = partner.primaryDomain
    ? `Основной домен — ${partner.primaryDomain}.`
    : "Основной домен не указан.";
  const stage = partner.currentStage
    ? `Текущая стадия — ${partner.currentStage.label}.`
    : "Активной возможности нет.";
  return `${partner.segment ?? "Сегмент не указан"}. ${domain} ${stage}`;
}

function restrictionNote(value: Prisma.JsonValue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return typeof value.note === "string" && value.note.trim() ? value.note : null;
}

function latestDate(values: Date[]) {
  return values.sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
}

function uniqueBy<T, K>(values: T[], key: (value: T) => K) {
  const unique = new Map<K, T>();
  for (const value of values) if (!unique.has(key(value))) unique.set(key(value), value);
  return [...unique.values()];
}

function auditActionLabel(action: string) {
  return (
    (
      {
        "contact.updated": "Обновлён контакт",
        "contact.archived": "Контакт перемещён в архив",
        "contact.restored": "Контакт восстановлен",
        "placement.register": "Добавлено размещение",
        "placement.update": "Обновлено размещение",
        "opportunity.stage_transition": "Изменена стадия возможности",
      } as Record<string, string>
    )[action] ?? action
  );
}
