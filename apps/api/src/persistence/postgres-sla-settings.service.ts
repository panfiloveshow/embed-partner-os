import { randomUUID } from "node:crypto";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { OpportunityStatus, Prisma } from "@prisma/client";
import type { SlaSettingsPayload } from "@embed-os/contracts";
import {
  parseUpdateSlaSettingsCommand,
  processSchemaWithSla,
  slaSettingsFromProcessDefinition,
} from "@embed-os/domain";
import { IdempotencyInProgressError, slaSettingsRequestHash } from "../application/idempotency.js";
import type { SlaSettingsPort } from "../sla-settings.port.js";
import { completeIdempotency, reserveOrReplay } from "./idempotency-gateway.js";
import { SlaSettingsVersionConflictError } from "../sla-settings.service.js";
import { PrismaService } from "./prisma.service.js";

@Injectable()
export class PostgresSlaSettingsService implements SlaSettingsPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async get(): Promise<SlaSettingsPayload> {
    const definition = await this.prisma.processDefinition.findFirst({
      where: { status: "PUBLISHED", publishedAt: { not: null } },
      orderBy: { version: "desc" },
    });
    if (!definition?.publishedAt) throw configurationMissing();
    const affectedOpportunities = await this.prisma.opportunity.count({
      where: {
        processVersion: definition.version,
        archivedAt: null,
        status: { not: OpportunityStatus.CLOSED },
      },
    });
    return slaSettingsFromProcessDefinition({
      id: definition.id,
      version: definition.version,
      publishedAt: definition.publishedAt,
      schema: definition.schemaJson,
      affectedOpportunities,
    });
  }

  async update(
    actorId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<SlaSettingsPayload> {
    const command = parseUpdateSlaSettingsCommand(input);
    const requestHash = slaSettingsRequestHash(command);
    const reservationId = randomUUID();
    const now = new Date();

    return this.prisma.$transaction(
      async (transaction) => {
        const replay = await reserveOrReplay(transaction, {
          recordId: reservationId,
          actorId,
          operation: "settings.sla.update",
          requestKey: idempotencyKey,
          requestHash,
          now,
        });
        if (replay !== null) {
          const parsed = parseResponse(replay);
          if (!parsed) throw new IdempotencyInProgressError(idempotencyKey);
          return parsed;
        }

        await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${"settings.sla.publish"}, 0))
      `);
        const current = await transaction.processDefinition.findFirst({
          where: { status: "PUBLISHED", publishedAt: { not: null } },
          orderBy: { version: "desc" },
        });
        if (!current?.publishedAt) throw configurationMissing();
        if (current.version !== command.version) {
          throw new SlaSettingsVersionConflictError(current.version);
        }
        const maxVersion = await transaction.processDefinition.aggregate({
          _max: { version: true },
        });
        const nextVersion = (maxVersion._max.version ?? current.version) + 1;
        const processDefinitionId = randomUUID();
        const schema = processSchemaWithSla(current.schemaJson, command);
        await transaction.processDefinition.create({
          data: {
            id: processDefinitionId,
            version: nextVersion,
            status: "PUBLISHED",
            schemaJson: schema as Prisma.InputJsonObject,
            publishedAt: now,
          },
        });
        const migrated = await transaction.opportunity.updateMany({
          where: {
            processVersion: current.version,
            archivedAt: null,
            status: { not: OpportunityStatus.CLOSED },
          },
          data: { processVersion: nextVersion },
        });
        const response = slaSettingsFromProcessDefinition({
          id: processDefinitionId,
          version: nextVersion,
          publishedAt: now,
          schema,
          affectedOpportunities: migrated.count,
        });
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId,
            action: "settings.sla.published",
            entityType: "ProcessDefinition",
            entityId: processDefinitionId,
            beforeJson: toJson({
              processDefinitionId: current.id,
              version: current.version,
            }),
            afterJson: toJson({
              ...response,
              reason: command.reason,
            }),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: "settings.sla.published",
            aggregateType: "ProcessDefinition",
            aggregateId: processDefinitionId,
            aggregateVersion: 1,
            schemaVersion: 1,
            payload: toJson({
              processDefinitionId,
              version: nextVersion,
              previousVersion: current.version,
              affectedOpportunities: migrated.count,
              escalationAfterDays: command.escalationAfterDays,
              thresholds: command.thresholds,
              reason: command.reason,
              actorId,
            }),
            occurredAt: now,
          },
        });
        await completeIdempotency(transaction, {
          recordId: reservationId,
          responseStatus: 200,
          responseJson: toJson(response),
          completedAt: now,
        });
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

function configurationMissing() {
  return new ServiceUnavailableException(
    "Опубликованная ProcessDefinition не найдена. Примените миграции и seed.",
  );
}

function parseResponse(value: unknown): SlaSettingsPayload | null {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { processDefinitionId?: unknown }).processDefinitionId !== "string" ||
    typeof (value as { version?: unknown }).version !== "number" ||
    !Array.isArray((value as { stages?: unknown }).stages)
  )
    return null;
  return value as SlaSettingsPayload;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
