import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  OpportunityStatus,
  Prisma,
  type ImportJob as DbImportJob,
  type ImportRow as DbImportRow,
} from "@prisma/client";
import {
  organizationImportFields,
  type CommitOrganizationImportCommand,
  type OrganizationImportDecision,
  type OrganizationImportJob,
  type OrganizationImportRow,
  type OrganizationImportValues,
} from "@embed-os/contracts";
import { opportunityStageLabel } from "@embed-os/domain";
import {
  classifyOrganizationImportRows,
  OrganizationImportFileError,
  parseCommitOrganizationImportCommand,
  parseOrganizationImportFile,
  summarizeImportRows,
  type ExistingImportOrganization,
  type OrganizationImportFile,
} from "../application/organization-import.js";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
} from "../application/idempotency.js";
import type { OrganizationImportPort } from "../organization-import.port.js";
import {
  OrganizationImportNotFoundError,
  OrganizationImportResolutionError,
  OrganizationImportStateError,
} from "../organization-import.service.js";
import {
  importJobScope,
  organizationScope,
  PersistenceActorService,
  requireActorTeam,
} from "./persistence-actor.service.js";
import { PrismaService } from "./prisma.service.js";

type DbJobWithRows = DbImportJob & { rows: DbImportRow[] };

@Injectable()
export class PostgresOrganizationImportService implements OrganizationImportPort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PersistenceActorService) private readonly actors: PersistenceActorService,
  ) {}

  async preview(file: OrganizationImportFile): Promise<OrganizationImportJob> {
    if (file.fileName.length > 255) {
      throw new OrganizationImportFileError(
        "IMPORT_FILE_NAME_TOO_LONG",
        "Имя файла не должно превышать 255 символов",
      );
    }
    const parsed = await parseOrganizationImportFile(file);
    const actor = await this.actors.current();
    const teamId = requireActorTeam(actor);
    const organizations = await this.prisma.organization.findMany({
      where: { archivedAt: null, ...organizationScope(actor) },
      select: {
        id: true,
        name: true,
        segment: true,
        domains: {
          where: { archivedAt: null },
          select: { hostNormalized: true },
        },
      },
    });
    const existing: ExistingImportOrganization[] = organizations.flatMap((organization) =>
      organization.domains.map(({ hostNormalized }) => ({
        id: organization.id,
        name: organization.name,
        domain: hostNormalized,
        segment: organization.segment,
      })));
    const rows = classifyOrganizationImportRows(parsed.rows, existing);
    const jobId = randomUUID();
    const created = await this.prisma.importJob.create({
      data: {
        id: jobId,
        teamId,
        actorId: actor.id,
        fileName: file.fileName,
        format: parsed.format,
        sourceHash: parsed.sourceHash,
        status: "PREVIEW",
        summaryJson: toJson(summarizeImportRows(rows)),
        warningsJson: toJson(parsed.warnings),
        rows: {
          create: rows.map((row) => ({
            id: randomUUID(),
            rowNo: row.rowNo,
            valuesJson: toJson(row.values),
            normalizedDomain: row.normalizedDomain,
            decision: row.decision.toUpperCase(),
            allowedDecisionsJson: toJson(row.allowedDecisions),
            matchedOrganizationId: uuidOrNull(row.matchedOrganization?.id),
            matchedOrganizationName: row.matchedOrganization?.name ?? null,
            fieldErrorsJson: toJson(row.fieldErrors),
            warningsJson: toJson(row.warnings),
            errorCode: row.errorCode,
          })),
        },
      },
      include: { rows: { orderBy: { rowNo: "asc" } } },
    });
    return mapJob(created);
  }

  async commit(
    jobId: string,
    input: CommitOrganizationImportCommand | unknown,
    idempotencyKey: string,
  ): Promise<OrganizationImportJob> {
    const command = parseCommitOrganizationImportCommand(input);
    const requestHash = hashCommand(command);
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const actor = await this.actors.current(transaction);
      const teamId = requireActorTeam(actor);
      const replay = await reserveIdempotency(transaction, {
        id: reservationId,
        actorId: actor.id,
        operation: `organization-import.commit:${jobId}`,
        idempotencyKey,
        requestHash,
        now,
      });
      if (replay !== null) return parseJobReplay(replay, idempotencyKey);
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`organization-import:${jobId}`}, 0))
      `);
      const current = await transaction.importJob.findFirst({
        where: { id: jobId, ...importJobScope(actor) },
        include: { rows: { orderBy: { rowNo: "asc" } } },
      });
      if (!current) throw new OrganizationImportNotFoundError(jobId);
      if (current.status !== "PREVIEW") {
        throw new OrganizationImportStateError(jobStatus(current.status));
      }
      const rows = mapRows(current.rows);
      const resolutions = new Map(
        (command.resolutions ?? []).map(({ rowNo, decision }) => [rowNo, decision]),
      );
      assertResolutions(rows, resolutions);
      const needsCreate = rows.some((row) =>
        row.decision === "create" || resolutions.get(row.rowNo) === "create");
      const process = needsCreate
        ? await transaction.processDefinition.findFirst({
            where: { status: "PUBLISHED" },
            orderBy: { version: "desc" },
            select: { version: true },
          })
        : null;
      if (needsCreate && !process) {
        throw new ServiceUnavailableException("Нет опубликованной версии воронки");
      }
      const users = await transaction.user.findMany({
        where: { teamId, status: "ACTIVE" },
        select: { id: true, email: true },
      });
      const userByEmail = new Map(users.map((user) => [user.email.toLocaleLowerCase("en-US"), user.id]));
      const appliedRows: OrganizationImportRow[] = [];

      for (const row of rows) {
        const effective = row.decision === "conflict"
          ? resolutions.get(row.rowNo)
          : row.decision;
        if (effective === "skip") {
          const skipped = { ...row, resolvedDecision: "skip" as const };
          await updateRowProtocol(transaction, current.id, skipped);
          appliedRows.push(skipped);
          continue;
        }
        if (effective === "update" && row.matchedOrganization) {
          const existing = await transaction.organization.findFirst({
            where: {
              id: row.matchedOrganization.id,
              archivedAt: null,
              ...organizationScope(actor),
            },
          });
          if (!existing) throw new OrganizationImportNotFoundError(jobId);
          const updated = await transaction.organization.update({
            where: { id: existing.id },
            data: {
              name: row.values.organization_name,
              segment: row.values.segment || existing.segment,
              version: { increment: 1 },
            },
          });
          await transaction.auditLog.create({
            data: {
              id: randomUUID(),
              actorId: actor.id,
              action: "organization.import-update",
              entityType: "Organization",
              entityId: updated.id,
              beforeJson: toJson({ name: existing.name, segment: existing.segment, version: existing.version }),
              afterJson: toJson({
                name: updated.name,
                segment: updated.segment,
                version: updated.version,
                importJobId: current.id,
                rowNo: row.rowNo,
              }),
              occurredAt: now,
            },
          });
          await transaction.outboxEvent.create({
            data: {
              id: randomUUID(),
              eventType: "organization.imported-update",
              aggregateType: "Organization",
              aggregateId: updated.id,
              aggregateVersion: updated.version,
              payload: toJson({ organizationId: updated.id, importJobId: current.id, rowNo: row.rowNo }),
              occurredAt: now,
            },
          });
          const applied = {
            ...row,
            resolvedDecision: "update" as const,
            entityId: updated.id,
            appliedAt: now.toISOString(),
          };
          await updateRowProtocol(transaction, current.id, applied);
          appliedRows.push(applied);
          continue;
        }

        const ownerId = userByEmail.get(row.values.owner_email.toLocaleLowerCase("en-US")) ?? actor.id;
        const organizationId = randomUUID();
        const opportunityId = randomUUID();
        const stageCode = row.values.stage || "S0";
        await transaction.organization.create({
          data: {
            id: organizationId,
            name: row.values.organization_name,
            segment: row.values.segment || null,
            ownerId,
            domains: {
              create: {
                id: randomUUID(),
                hostNormalized: row.normalizedDomain ?? row.values.domain,
                isPrimary: true,
                source: `import:${current.id}`,
              },
            },
          },
        });
        await transaction.opportunity.create({
          data: {
            id: opportunityId,
            organizationId,
            processVersion: process?.version ?? 1,
            ownerId,
            type: "initial-embed",
            stageCode,
            stageLabel: opportunityStageLabel(stageCode as Parameters<typeof opportunityStageLabel>[0]),
            status: statusForStage(stageCode),
            score: 0,
            stageData: {},
          },
        });
        if (row.values.contact_name) {
          await createImportedContact(transaction, row, organizationId, current.id);
        }
        if (row.values.last_interaction_at) {
          await transaction.interaction.create({
            data: {
              id: randomUUID(),
              opportunityId,
              authorId: ownerId,
              type: "Импорт",
              occurredAt: new Date(row.values.last_interaction_at),
              summary: row.values.notes || "Импортировано из исходной таблицы",
              outcome: "Импортировано",
              source: `import:${current.id}`,
            },
          });
        }
        if (row.values.next_action && row.values.next_action_due_at) {
          const task = await transaction.task.create({
            data: {
              id: randomUUID(),
              opportunityId,
              ownerId,
              type: "follow-up",
              title: truncate(row.values.next_action, 200),
              dueAt: new Date(row.values.next_action_due_at),
              priorityScore: 0,
              priorityReasons: [],
              source: `import:${current.id}`,
            },
          });
          await transaction.opportunity.update({
            where: { id: opportunityId },
            data: { nextTaskId: task.id },
          });
        }
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId: actor.id,
            action: "organization.import-create",
            entityType: "Organization",
            entityId: organizationId,
            afterJson: toJson({
              importJobId: current.id,
              rowNo: row.rowNo,
              organizationName: row.values.organization_name,
              domain: row.normalizedDomain,
              opportunityId,
            }),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: "organization.imported",
            aggregateType: "Organization",
            aggregateId: organizationId,
            aggregateVersion: 1,
            payload: toJson({ organizationId, opportunityId, importJobId: current.id, rowNo: row.rowNo }),
            occurredAt: now,
          },
        });
        const applied = {
          ...row,
          resolvedDecision: "create" as const,
          entityId: organizationId,
          appliedAt: now.toISOString(),
        };
        await updateRowProtocol(transaction, current.id, applied);
        appliedRows.push(applied);
      }

      const summary = summarizeImportRows(appliedRows);
      await transaction.importJob.update({
        where: { id: current.id },
        data: { status: "COMMITTED", summaryJson: toJson(summary), completedAt: now },
      });
      await recordJobEvent(transaction, {
        actorId: actor.id,
        jobId: current.id,
        action: "organization-import.commit",
        eventType: "organization-import.committed",
        payload: { summary },
        occurredAt: now,
      });
      const response = mapJob({
        ...current,
        status: "COMMITTED",
        completedAt: now,
        rows: current.rows,
      }, appliedRows);
      await completeIdempotency(transaction, reservationId, response, now);
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async cancel(jobId: string, idempotencyKey: string): Promise<OrganizationImportJob> {
    const now = new Date();
    const reservationId = randomUUID();
    return this.prisma.$transaction(async (transaction) => {
      const actor = await this.actors.current(transaction);
      const replay = await reserveIdempotency(transaction, {
        id: reservationId,
        actorId: actor.id,
        operation: `organization-import.cancel:${jobId}`,
        idempotencyKey,
        requestHash: hashCommand({ action: "cancel" }),
        now,
      });
      if (replay !== null) return parseJobReplay(replay, idempotencyKey);
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`organization-import:${jobId}`}, 0))
      `);
      const current = await transaction.importJob.findFirst({
        where: { id: jobId, ...importJobScope(actor) },
        include: { rows: { orderBy: { rowNo: "asc" } } },
      });
      if (!current) throw new OrganizationImportNotFoundError(jobId);
      if (current.status !== "PREVIEW") {
        throw new OrganizationImportStateError(jobStatus(current.status));
      }
      const updated = await transaction.importJob.update({
        where: { id: current.id },
        data: { status: "CANCELLED", completedAt: now },
        include: { rows: { orderBy: { rowNo: "asc" } } },
      });
      await recordJobEvent(transaction, {
        actorId: actor.id,
        jobId: current.id,
        action: "organization-import.cancel",
        eventType: "organization-import.cancelled",
        payload: { sourceHash: current.sourceHash },
        occurredAt: now,
      });
      const response = mapJob(updated);
      await completeIdempotency(transaction, reservationId, response, now);
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

}

async function createImportedContact(
  transaction: Prisma.TransactionClient,
  row: OrganizationImportRow,
  organizationId: string,
  jobId: string,
) {
  const existing = row.values.contact_email
    ? await transaction.contact.findFirst({
        where: {
          email: { equals: row.values.contact_email, mode: "insensitive" },
          mergedIntoId: null,
          archivedAt: null,
        },
        select: { id: true },
      })
    : null;
  const contactId = existing?.id ?? randomUUID();
  if (!existing) {
    await transaction.contact.create({
      data: {
        id: contactId,
        fullName: row.values.contact_name,
        email: row.values.contact_email || null,
        phone: row.values.contact_phone || null,
        source: `import:${jobId}`,
        restrictions: {},
      },
    });
  }
  await transaction.contactOrganization.create({
    data: {
      id: randomUUID(),
      contactId,
      organizationId,
      role: row.values.contact_role || "Контакт",
      isPrimary: true,
    },
  });
}

async function updateRowProtocol(
  transaction: Prisma.TransactionClient,
  jobId: string,
  row: OrganizationImportRow,
) {
  await transaction.importRow.update({
    where: { jobId_rowNo: { jobId, rowNo: row.rowNo } },
    data: {
      resolvedDecision: row.resolvedDecision?.toUpperCase() ?? null,
      entityId: uuidOrNull(row.entityId),
      appliedAt: row.appliedAt ? new Date(row.appliedAt) : null,
    },
  });
}

function mapJob(job: DbJobWithRows, mappedRows?: OrganizationImportRow[]): OrganizationImportJob {
  const rows = mappedRows ?? mapRows(job.rows);
  return {
    id: job.id,
    fileName: job.fileName,
    format: job.format === "xlsx" ? "xlsx" : "csv",
    sourceHash: job.sourceHash,
    status: jobStatus(job.status),
    summary: summarizeImportRows(rows),
    warnings: stringArray(job.warningsJson),
    rows,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

function mapRows(rows: DbImportRow[]): OrganizationImportRow[] {
  return rows.map((row) => ({
    rowNo: row.rowNo,
    values: importValues(row.valuesJson),
    normalizedDomain: row.normalizedDomain,
    decision: importDecision(row.decision),
    resolvedDecision: resolvedDecision(row.resolvedDecision),
    allowedDecisions: stringArray(row.allowedDecisionsJson).filter(
      (value): value is "create" | "skip" => value === "create" || value === "skip",
    ),
    matchedOrganization: row.matchedOrganizationId && row.matchedOrganizationName
      ? { id: row.matchedOrganizationId, name: row.matchedOrganizationName }
      : null,
    fieldErrors: stringRecord(row.fieldErrorsJson),
    warnings: stringArray(row.warningsJson),
    errorCode: row.errorCode,
    entityId: row.entityId,
    appliedAt: row.appliedAt?.toISOString() ?? null,
  }));
}

function assertResolutions(
  rows: OrganizationImportRow[],
  resolutions: Map<number, "create" | "skip">,
) {
  const unresolved = rows.filter((row) => row.decision === "conflict" && !resolutions.has(row.rowNo));
  if (unresolved.length > 0) throw new OrganizationImportResolutionError(unresolved);
  for (const [rowNo, resolution] of resolutions) {
    const row = rows.find((candidate) => candidate.rowNo === rowNo);
    if (!row || row.decision !== "conflict" || !row.allowedDecisions.includes(resolution)) {
      throw new OrganizationImportResolutionError(row ? [row] : [{ rowNo } as OrganizationImportRow]);
    }
  }
}

async function recordJobEvent(
  transaction: Prisma.TransactionClient,
  input: {
    actorId: string;
    jobId: string;
    action: string;
    eventType: string;
    payload: unknown;
    occurredAt: Date;
  },
) {
  await transaction.auditLog.create({
    data: {
      id: randomUUID(),
      actorId: input.actorId,
      action: input.action,
      entityType: "ImportJob",
      entityId: input.jobId,
      afterJson: toJson(input.payload),
      occurredAt: input.occurredAt,
    },
  });
  await transaction.outboxEvent.create({
    data: {
      id: randomUUID(),
      eventType: input.eventType,
      aggregateType: "ImportJob",
      aggregateId: input.jobId,
      aggregateVersion: 1,
      payload: toJson({ importJobId: input.jobId, ...asRecord(input.payload) }),
      occurredAt: input.occurredAt,
    },
  });
}

async function reserveIdempotency(
  transaction: Prisma.TransactionClient,
  input: {
    id: string;
    actorId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    now: Date;
  },
): Promise<Prisma.JsonValue | null> {
  const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "idempotency_record" (
      "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
    ) VALUES (
      ${input.id}::uuid,
      ${input.actorId}::uuid,
      ${input.operation},
      ${input.idempotencyKey},
      ${input.requestHash},
      ${input.now},
      ${new Date(input.now.getTime() + 24 * 60 * 60 * 1_000)}
    )
    ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
    RETURNING "id"
  `);
  if (inserted.length > 0) return null;
  const existing = await transaction.idempotencyRecord.findUnique({
    where: {
      actorId_operation_requestKey: {
        actorId: input.actorId,
        operation: input.operation,
        requestKey: input.idempotencyKey,
      },
    },
  });
  if (!existing) throw new IdempotencyInProgressError(input.idempotencyKey);
  if (existing.requestHash !== input.requestHash) throw new IdempotencyConflictError(input.idempotencyKey);
  if (existing.responseJson === null) throw new IdempotencyInProgressError(input.idempotencyKey);
  return existing.responseJson;
}

async function completeIdempotency(
  transaction: Prisma.TransactionClient,
  reservationId: string,
  response: OrganizationImportJob,
  now: Date,
) {
  await transaction.idempotencyRecord.update({
    where: { id: reservationId },
    data: { responseStatus: 200, responseJson: toJson(response), completedAt: now },
  });
}

function parseJobReplay(value: Prisma.JsonValue, key: string): OrganizationImportJob {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.rows)) {
    throw new IdempotencyInProgressError(key);
  }
  return value as unknown as OrganizationImportJob;
}

function importValues(value: Prisma.JsonValue): OrganizationImportValues {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(organizationImportFields.map((field) => [
    field,
    typeof record[field] === "string" ? record[field] : "",
  ])) as OrganizationImportValues;
}

function importDecision(value: string): OrganizationImportDecision {
  const normalized = value.toLocaleLowerCase("en-US");
  return normalized === "create" || normalized === "update" ||
    normalized === "skip" || normalized === "conflict"
    ? normalized
    : "conflict";
}

function resolvedDecision(value: string | null) {
  const normalized = value?.toLocaleLowerCase("en-US");
  return normalized === "create" || normalized === "update" || normalized === "skip"
    ? normalized
    : null;
}

function jobStatus(value: string): OrganizationImportJob["status"] {
  if (value === "COMMITTED") return "committed";
  if (value === "CANCELLED") return "cancelled";
  return "preview";
}

function statusForStage(stageCode: string): OpportunityStatus {
  if (stageCode === "SL") return OpportunityStatus.CLOSED;
  if (stageCode === "SX") return OpportunityStatus.PAUSED;
  return OpportunityStatus.ACTIVE;
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: Prisma.JsonValue): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function uuidOrNull(value: string | undefined | null) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function hashCommand(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown) {
  return isRecord(value) ? value : { value };
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
