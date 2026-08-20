import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  PartnerExportAuditView,
  PartnerCardPayload,
  PartnerIntegrationStatus,
  PartnerMetricView,
  OrganizationGroupView,
  PartnerRegistryItem,
  PartnerRegistryPayload,
  PlacementView,
  TodayAction,
} from "@embed-os/contracts";
import {
  ExportPermissionDeniedError,
  createPartnerExport,
  resolveExportActor,
} from "./application/partner-export.js";
import { PLACEMENT_PORT, type PlacementPort } from "./placement.port.js";
import type { PartnerPort, PartnerRegistryQuery } from "./partner.port.js";
import { TodayService } from "./today.service.js";

export class PartnerNotFoundError extends Error {
  readonly code = "PARTNER_NOT_FOUND";
  constructor(readonly organizationId: string) {
    super(`Организация ${organizationId} не найдена`);
    this.name = "PartnerNotFoundError";
  }
}

@Injectable()
export class PartnerService implements PartnerPort {
  private readonly exportAudit: PartnerExportAuditView[] = [];

  constructor(
    @Inject(TodayService) private readonly today: TodayService,
    @Inject(PLACEMENT_PORT) private readonly placements: PlacementPort,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {}

  async listPartners(query: PartnerRegistryQuery = {}): Promise<PartnerRegistryPayload> {
    const now = this.clock();
    const today = this.today.getToday();
    const placements = await this.placements.list();
    const allPartners = groupActions(today.actions).map((actions) =>
      toRegistryItem(actions, placements),
    );
    const partners = allPartners
      .filter((partner) => matchesPartner(partner, query))
      .sort(
        (left, right) =>
          (right.partnerScore ?? -1) - (left.partnerScore ?? -1) ||
          left.name.localeCompare(right.name, "ru"),
      );

    return {
      generatedAt: now.toISOString(),
      teamName: today.teamName,
      total: partners.length,
      truncated: partners.length > PARTNER_PAGE_LIMIT,
      filters: registryFilters(allPartners),
      partners: structuredClone(partners.slice(0, PARTNER_PAGE_LIMIT)),
    };
  }

  async getPartner(organizationId: string): Promise<PartnerCardPayload> {
    const now = this.clock();
    const today = this.today.getToday();
    const actions = today.actions.filter((action) => action.organizationId === organizationId);
    if (actions.length === 0) throw new PartnerNotFoundError(organizationId);
    const allPlacements = await this.placements.list();
    const placements = allPlacements.filter(
      (placement) => placement.organizationId === organizationId,
    );
    const organization = toRegistryItem(actions, placements);
    const contacts = this.today.listContacts({ status: "active", organizationId }).contacts;
    const opportunityActions = uniqueBy(actions, ({ opportunityId }) => opportunityId);
    const interactions = actions
      .filter((action) => action.lastInteraction !== null)
      .map((action) => ({
        id: `interaction:${action.id}`,
        type: action.lastInteraction?.type ?? "Событие",
        occurredAt: action.lastInteraction?.occurredAt ?? now.toISOString(),
        contactName: action.lastInteraction?.contactName ?? null,
        authorName: action.ownerName,
        outcome: action.lastInteraction?.outcome ?? "Не указан",
        summary: action.lastInteraction?.summary ?? "",
        source: "Демонстрационные данные",
      }))
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
    const tasks = actions
      .map((action) => ({
        id: action.id,
        opportunityId: action.opportunityId,
        title: action.title,
        dueAt: action.dueAt ?? now.toISOString(),
        status: action.group === "waiting" ? "WAITING" : "OPEN",
        ownerName: action.ownerName,
        outcome: null,
      }))
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    const opportunities = opportunityActions.map((action) => ({
      id: action.opportunityId,
      type: "EMBED",
      stageCode: action.stageCode,
      stageLabel: action.stageLabel,
      status: action.opportunityStatus,
      score: action.partnerScore ?? 0,
      owner: { id: "user-anna", name: action.ownerName },
      nextAction: action.dueAt ? { id: action.id, title: action.title, dueAt: action.dueAt } : null,
      updatedAt: action.lastInteraction?.occurredAt ?? action.dueAt ?? now.toISOString(),
    }));
    const metrics = partnerMetrics(organization, now);
    return {
      generatedAt: now.toISOString(),
      summary: partnerSummary(organization),
      organization,
      organizationGroup: demoOrganizationGroup(organization, today.actions, allPlacements),
      contacts,
      opportunities,
      interactions,
      tasks,
      placements: structuredClone(placements),
      metrics,
      documents: [],
      audit: interactions.map((interaction) => ({
        id: `audit:${interaction.id}`,
        action: "interaction.recorded",
        entityType: "Organization",
        entityId: organizationId,
        actorName: interaction.authorName,
        occurredAt: interaction.occurredAt,
        summary: interaction.summary,
      })),
    };
  }

  async exportPartners(query: PartnerRegistryQuery, rawActorSubject: string) {
    const actorSubject = memoryExportActor(rawActorSubject);
    const registry = await this.listPartners(query);
    const result = createPartnerExport(
      registry.partners,
      query,
      actorSubject,
      randomUUID(),
      this.clock(),
    );
    this.exportAudit.unshift(structuredClone(result.audit));
    return result;
  }

  async listPartnerExportAudit(rawActorSubject: string) {
    memoryExportActor(rawActorSubject);
    return structuredClone(this.exportAudit);
  }
}

const PARTNER_PAGE_LIMIT = 200;

function memoryExportActor(rawActorSubject: string) {
  const actorSubject = resolveExportActor(rawActorSubject);
  if (actorSubject !== "bootstrap:anna.sokolova") throw new ExportPermissionDeniedError();
  return actorSubject;
}

function groupActions(actions: TodayAction[]) {
  const grouped = new Map<string, TodayAction[]>();
  for (const action of actions) {
    const current = grouped.get(action.organizationId) ?? [];
    current.push(action);
    grouped.set(action.organizationId, current);
  }
  return [...grouped.values()];
}

function toRegistryItem(actions: TodayAction[], placements: PlacementView[]): PartnerRegistryItem {
  const primary = [...actions].sort(
    (left, right) => (right.partnerScore ?? -1) - (left.partnerScore ?? -1),
  )[0];
  if (!primary) throw new Error("Partner action group is empty");
  const organizationPlacements = placements.filter(
    (placement) => placement.organizationId === primary.organizationId,
  );
  const opportunityActions = uniqueBy(actions, ({ opportunityId }) => opportunityId);
  const contacts = new Set(actions.flatMap((action) => action.contacts.map(({ id }) => id)));
  const domains = uniqueBy(actions, ({ domain }) => domain).map((action, index) => ({
    id: `domain:${primary.organizationId}:${index + 1}`,
    host: action.domain,
    isPrimary: index === 0,
    verifiedAt: action.opportunityStageData?.researchCheckedAt ?? null,
  }));
  const lastActivityAt = latestIso(
    actions.flatMap((action) => [action.lastInteraction?.occurredAt ?? null]),
  );
  const nextActionSource = [...actions]
    .filter((action) => action.dueAt !== null)
    .sort((left, right) => (left.dueAt ?? "").localeCompare(right.dueAt ?? ""))[0];
  return {
    id: primary.organizationId,
    version: 1,
    name: primary.organizationName,
    legalName: demoLegalName(primary.organizationId),
    segment: primary.organizationSegment ?? null,
    status: "ACTIVE",
    primaryDomain: domains[0]?.host ?? null,
    domains,
    organizationGroup: demoGroupRef(primary.organizationId),
    owner: { id: "user-anna", name: primary.ownerName },
    currentStage: { code: primary.stageCode, label: primary.stageLabel },
    partnerScore: primary.partnerScore ?? null,
    integrationStatus: integrationStatus(organizationPlacements, opportunityActions),
    lastActivityAt,
    nextAction: nextActionSource?.dueAt
      ? { id: nextActionSource.id, title: nextActionSource.title, dueAt: nextActionSource.dueAt }
      : null,
    counts: {
      contacts: contacts.size,
      opportunities: opportunityActions.length,
      tasks: uniqueBy(actions, ({ id }) => id).length,
      placements: organizationPlacements.length,
      documents: 0,
    },
  };
}

function integrationStatus(
  placements: PlacementView[],
  opportunities: TodayAction[],
): PartnerIntegrationStatus {
  if (
    placements.some(
      (placement) =>
        placement.healthStatus === "failed" ||
        placement.healthStatus === "degraded" ||
        placement.activeAlert !== null,
    )
  )
    return "issue";
  if (placements.some(({ businessStatus }) => businessStatus === "active")) return "active";
  if (
    placements.some(({ businessStatus }) => businessStatus === "planned") ||
    opportunities.some(({ stageCode }) => ["S7", "S8", "S9", "S10"].includes(stageCode))
  )
    return "planned";
  return "not_started";
}

function matchesPartner(partner: PartnerRegistryItem, query: PartnerRegistryQuery) {
  const search = query.search?.toLocaleLowerCase("ru");
  if (
    search &&
    ![
      partner.name,
      partner.legalName,
      partner.segment,
      partner.organizationGroup?.name,
      ...partner.domains.map(({ host }) => host),
    ].some((value) => value?.toLocaleLowerCase("ru").includes(search))
  )
    return false;
  if (query.groupId && partner.organizationGroup?.id !== query.groupId) return false;
  if (query.segment && partner.segment !== query.segment) return false;
  if (query.ownerId && partner.owner?.id !== query.ownerId) return false;
  if (query.stageCode && partner.currentStage?.code !== query.stageCode) return false;
  if (query.scoreMin !== undefined && (partner.partnerScore ?? -1) < query.scoreMin) return false;
  if (
    query.scoreMax !== undefined &&
    (partner.partnerScore ?? Number.POSITIVE_INFINITY) > query.scoreMax
  )
    return false;
  if (query.integrationStatus && partner.integrationStatus !== query.integrationStatus)
    return false;
  if (query.activeAfter && (!partner.lastActivityAt || partner.lastActivityAt < query.activeAfter))
    return false;
  return true;
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

const DEMO_MEDIA_GROUP = {
  id: "group-media",
  name: "Медиа Альянс",
  version: 1,
  memberIds: new Set(["org-task-1", "org-task-3"]),
};

function demoGroupRef(organizationId: string) {
  return DEMO_MEDIA_GROUP.memberIds.has(organizationId)
    ? { id: DEMO_MEDIA_GROUP.id, name: DEMO_MEDIA_GROUP.name }
    : null;
}

function demoLegalName(organizationId: string) {
  if (organizationId === "org-task-1") return "ООО «Медиа Новости»";
  if (organizationId === "org-task-3") return "АО «Городской портал»";
  return null;
}

function demoOrganizationGroup(
  organization: PartnerRegistryItem,
  actions: TodayAction[],
  placements: PlacementView[],
): OrganizationGroupView | null {
  if (!organization.organizationGroup) return null;
  const members = groupActions(actions)
    .filter((memberActions) => {
      const id = memberActions[0]?.organizationId;
      return id ? DEMO_MEDIA_GROUP.memberIds.has(id) : false;
    })
    .map((memberActions) => toRegistryItem(memberActions, placements))
    .sort((left, right) => left.name.localeCompare(right.name, "ru"))
    .map((member) => ({
      id: member.id,
      name: member.name,
      legalName: member.legalName,
      primaryDomain: member.primaryDomain,
      domains: member.domains.map(({ host }) => host),
    }));
  return {
    id: DEMO_MEDIA_GROUP.id,
    name: DEMO_MEDIA_GROUP.name,
    version: DEMO_MEDIA_GROUP.version,
    members,
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

function latestIso(values: Array<string | null>) {
  return (
    values
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null
  );
}

function uniqueBy<T, K>(values: T[], key: (value: T) => K) {
  const unique = new Map<K, T>();
  for (const value of values) if (!unique.has(key(value))) unique.set(key(value), value);
  return [...unique.values()];
}
