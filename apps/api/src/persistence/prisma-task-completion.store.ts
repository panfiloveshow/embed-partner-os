import { OpportunityStatus, Prisma, type PrismaClient, TaskStatus } from "@prisma/client";
import type {
  CompletionResult,
  CompletionTaskRecord,
  CompletionTransaction,
  CompletionTransactionRunner,
  IdempotencyReservation,
  NewTaskRecord,
  OpportunityCompletionPatch,
} from "../application/task-completion.service.js";
import {
  completeIdempotency as completeIdempotencyRecord,
  reserveIdempotency as reserveIdempotencyRecord,
} from "./idempotency-gateway.js";

type PrismaTransaction = Prisma.TransactionClient;

export class PrismaTaskCompletionStore implements CompletionTransactionRunner {
  constructor(private readonly prisma: PrismaClient) {}

  transaction<T>(work: (transaction: CompletionTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      (transaction) => work(new PrismaCompletionTransaction(transaction)),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}

class PrismaCompletionTransaction implements CompletionTransaction {
  constructor(private readonly transaction: PrismaTransaction) {}

  async reserveIdempotency(input: {
    id: string;
    actorId: string;
    operation: string;
    key: string;
    requestHash: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<IdempotencyReservation> {
    const reservation = await reserveIdempotencyRecord(this.transaction, {
      recordId: input.id,
      actorId: input.actorId,
      operation: input.operation,
      requestKey: input.key,
      requestHash: input.requestHash,
      now: input.createdAt,
      expiresAt: input.expiresAt,
    });
    if (reservation.state === "reserved") {
      return { state: "reserved", recordId: input.id };
    }
    if (reservation.state === "missing") {
      throw new Error("Idempotency reservation disappeared after a uniqueness conflict");
    }
    return {
      state: "existing",
      requestHash: reservation.requestHash,
      result: parseCompletionResult(reservation.responseJson),
    };
  }

  async completeIdempotency(input: {
    recordId: string;
    result: CompletionResult;
    completedAt: Date;
  }): Promise<void> {
    await completeIdempotencyRecord(this.transaction, {
      recordId: input.recordId,
      responseStatus: 200,
      responseJson: toJson(input.result),
      completedAt: input.completedAt,
    });
  }

  async getTask(taskId: string): Promise<CompletionTaskRecord | null> {
    const task = await this.transaction.task.findUnique({
      where: { id: taskId },
      include: {
        opportunity: {
          include: {
            organization: {
              include: {
                contactLinks: {
                  where: {
                    validTo: null,
                    contact: { archivedAt: null, mergedIntoId: null },
                  },
                  select: { contactId: true },
                },
              },
            },
          },
        },
      },
    });
    if (!task) return null;

    return {
      id: task.id,
      opportunityId: task.opportunityId,
      ownerId: task.ownerId,
      title: task.title,
      status: task.status,
      version: task.version,
      priorityScore: task.priorityScore,
      opportunity: {
        contactIds: task.opportunity.organization.contactLinks.map(({ contactId }) => contactId),
        version: task.opportunity.version,
        stageCode: task.opportunity.stageCode,
        status: task.opportunity.status,
        score: task.opportunity.score,
        nextTaskId: task.opportunity.nextTaskId,
      },
    };
  }

  async completeTaskIfVersion(input: {
    taskId: string;
    expectedVersion: number;
    outcome: string;
    completedAt: Date;
  }): Promise<boolean> {
    const result = await this.transaction.task.updateMany({
      where: {
        id: input.taskId,
        version: input.expectedVersion,
        status: TaskStatus.OPEN,
      },
      data: {
        status: TaskStatus.COMPLETED,
        outcome: input.outcome,
        completedAt: input.completedAt,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  async createInteraction(input: {
    id: string;
    opportunityId: string;
    taskId: string;
    contactId: string;
    actorId: string;
    interactionType: string;
    occurredAt: Date;
    summary: string;
    outcome: string;
  }): Promise<void> {
    await this.transaction.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`contact-merge:${input.contactId}`}, 0))
    `);
    const contact = await this.transaction.contact.findUnique({
      where: { id: input.contactId },
      select: { mergedIntoId: true },
    });
    const effectiveContactId = contact?.mergedIntoId ?? input.contactId;
    await this.transaction.interaction.create({
      data: {
        id: input.id,
        opportunityId: input.opportunityId,
        taskId: input.taskId,
        contactId: effectiveContactId,
        authorId: input.actorId,
        type: input.interactionType,
        occurredAt: input.occurredAt,
        summary: input.summary,
        outcome: input.outcome,
        source: "web",
      },
    });
  }

  async createTask(input: NewTaskRecord): Promise<void> {
    await this.transaction.task.create({
      data: {
        id: input.id,
        opportunityId: input.opportunityId,
        ownerId: input.ownerId,
        type: input.type,
        title: input.title,
        dueAt: input.dueAt,
        priorityScore: input.priorityScore,
        priorityReasons: toJson(input.priorityReasons),
        status: TaskStatus.OPEN,
        source: input.source,
      },
    });
  }

  async updateOpportunityIfVersion(input: {
    opportunityId: string;
    expectedVersion: number;
    patch: OpportunityCompletionPatch;
  }): Promise<boolean> {
    const patch = input.patch;
    const result = await this.transaction.opportunity.updateMany({
      where: { id: input.opportunityId, version: input.expectedVersion },
      data: {
        nextTaskId: patch.nextTaskId,
        status: patch.status as OpportunityStatus,
        ...(patch.stageCode ? { stageCode: patch.stageCode } : {}),
        ...(patch.stageLabel ? { stageLabel: patch.stageLabel } : {}),
        waitingReason: patch.waitingReason,
        waitingFor: patch.waitingFor,
        reviewAt: patch.reviewAt,
        closeReason: patch.closeReason,
        closeComment: patch.closeComment,
        returnAt: patch.returnAt,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  async createAuditLog(input: {
    id: string;
    actorId: string;
    entityId: string;
    occurredAt: Date;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }): Promise<void> {
    await this.transaction.auditLog.create({
      data: {
        id: input.id,
        actorId: input.actorId,
        action: "task.complete",
        entityType: "Task",
        entityId: input.entityId,
        beforeJson: toJson(input.before),
        afterJson: toJson(input.after),
        occurredAt: input.occurredAt,
      },
    });
  }

  async createStageHistory(input: {
    id: string;
    opportunityId: string;
    actorId: string;
    fromStage: string;
    toStage: string;
    reason: string;
    occurredAt: Date;
  }): Promise<void> {
    await this.transaction.stageHistory.create({
      data: {
        id: input.id,
        opportunityId: input.opportunityId,
        actorId: input.actorId,
        fromStage: input.fromStage,
        toStage: input.toStage,
        reason: input.reason,
        occurredAt: input.occurredAt,
      },
    });
  }

  async createOutboxEvent(input: {
    id: string;
    taskId: string;
    aggregateVersion: number;
    occurredAt: Date;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.transaction.outboxEvent.create({
      data: {
        id: input.id,
        eventType: "task.completed",
        aggregateType: "Task",
        aggregateId: input.taskId,
        aggregateVersion: input.aggregateVersion,
        schemaVersion: 1,
        payload: toJson(input.payload),
        occurredAt: input.occurredAt,
      },
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseCompletionResult(value: Prisma.JsonValue | null): CompletionResult | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.taskId !== "string" ||
    typeof value.opportunityId !== "string" ||
    !(typeof value.nextTaskId === "string" || value.nextTaskId === null) ||
    typeof value.outboxEventId !== "string"
  ) {
    return null;
  }
  return {
    taskId: value.taskId,
    opportunityId: value.opportunityId,
    nextTaskId: value.nextTaskId,
    outboxEventId: value.outboxEventId,
  };
}
