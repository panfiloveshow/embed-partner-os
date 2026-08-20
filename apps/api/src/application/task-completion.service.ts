import { randomUUID } from "node:crypto";
import type { CompleteTaskCommand, PriorityReason } from "@embed-os/contracts";
import { calculatePriority, parseCompleteTaskCommand } from "@embed-os/domain";
import {
  completionRequestHash,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  parseIdempotencyKey,
} from "./idempotency.js";

export interface CompletionTaskRecord {
  id: string;
  opportunityId: string;
  ownerId: string;
  title: string;
  status: "OPEN" | "COMPLETED" | "CANCELLED";
  version: number;
  priorityScore: number;
  opportunity: {
    contactIds: string[];
    version: number;
    stageCode: string;
    status: "ACTIVE" | "WAITING" | "PAUSED" | "CLOSED";
    score: number;
    nextTaskId: string | null;
  };
}

export interface NewTaskRecord {
  id: string;
  opportunityId: string;
  ownerId: string;
  type: string;
  title: string;
  dueAt: Date;
  priorityScore: number;
  priorityReasons: PriorityReason[];
  source: string;
}

export interface OpportunityCompletionPatch {
  nextTaskId: string | null;
  status: "ACTIVE" | "WAITING" | "PAUSED" | "CLOSED";
  stageCode?: string;
  stageLabel?: string;
  waitingReason?: string | null;
  waitingFor?: string | null;
  reviewAt?: Date | null;
  closeReason?: string | null;
  closeComment?: string | null;
  returnAt?: Date | null;
}

export type IdempotencyReservation =
  | { state: "reserved"; recordId: string }
  | {
      state: "existing";
      requestHash: string;
      result: CompletionResult | null;
    };

export interface CompletionTransaction {
  reserveIdempotency(input: {
    id: string;
    actorId: string;
    operation: string;
    key: string;
    requestHash: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<IdempotencyReservation>;
  completeIdempotency(input: {
    recordId: string;
    result: CompletionResult;
    completedAt: Date;
  }): Promise<void>;
  getTask(taskId: string): Promise<CompletionTaskRecord | null>;
  completeTaskIfVersion(input: {
    taskId: string;
    expectedVersion: number;
    outcome: string;
    completedAt: Date;
  }): Promise<boolean>;
  createInteraction(input: {
    id: string;
    opportunityId: string;
    taskId: string;
    contactId: string;
    actorId: string;
    interactionType: string;
    occurredAt: Date;
    summary: string;
    outcome: string;
  }): Promise<void>;
  createTask(input: NewTaskRecord): Promise<void>;
  updateOpportunityIfVersion(input: {
    opportunityId: string;
    expectedVersion: number;
    patch: OpportunityCompletionPatch;
  }): Promise<boolean>;
  createStageHistory(input: {
    id: string;
    opportunityId: string;
    actorId: string;
    fromStage: string;
    toStage: string;
    reason: string;
    occurredAt: Date;
  }): Promise<void>;
  createAuditLog(input: {
    id: string;
    actorId: string;
    entityId: string;
    occurredAt: Date;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }): Promise<void>;
  createOutboxEvent(input: {
    id: string;
    taskId: string;
    aggregateVersion: number;
    occurredAt: Date;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface CompletionTransactionRunner {
  transaction<T>(work: (transaction: CompletionTransaction) => Promise<T>): Promise<T>;
}

export interface CompletionResult {
  taskId: string;
  opportunityId: string;
  nextTaskId: string | null;
  outboxEventId: string;
}

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Задача ${taskId} не найдена`);
    this.name = "TaskNotFoundError";
  }
}

export class ConcurrencyConflictError extends Error {
  readonly code = "CONCURRENT_MODIFICATION";

  constructor(
    readonly entityType: "Task" | "Opportunity",
    readonly entityId: string,
  ) {
    super("Запись уже изменена другим пользователем. Обновите данные и повторите действие.");
    this.name = "ConcurrencyConflictError";
  }
}

export class ContactNotAvailableError extends Error {
  readonly code = "CONTACT_NOT_AVAILABLE";
  readonly fieldErrors = {
    contactId: "Выберите действующий контакт, связанный с организацией",
  };

  constructor(readonly contactId: string) {
    super("Выбранный контакт не связан с организацией этой задачи");
    this.name = "ContactNotAvailableError";
  }
}

export class TaskCompletionApplicationService {
  constructor(
    private readonly store: CompletionTransactionRunner,
    private readonly clock: () => Date = () => new Date(),
    private readonly idGenerator: () => string = randomUUID,
  ) {}

  async complete(
    taskId: string,
    actorId: string,
    rawCommand: unknown,
    rawIdempotencyKey: unknown,
  ): Promise<CompletionResult> {
    const command = parseCompleteTaskCommand(rawCommand);
    const idempotencyKey = parseIdempotencyKey(rawIdempotencyKey);
    const requestHash = completionRequestHash(command);
    const occurredAt = this.clock();
    const operation = `task.complete:${taskId}`;

    return this.store.transaction(async (transaction) => {
      const reservation = await transaction.reserveIdempotency({
        id: this.idGenerator(),
        actorId,
        operation,
        key: idempotencyKey,
        requestHash,
        createdAt: occurredAt,
        expiresAt: new Date(occurredAt.getTime() + 24 * 60 * 60 * 1_000),
      });
      if (reservation.state === "existing") {
        if (reservation.requestHash !== requestHash) {
          throw new IdempotencyConflictError(idempotencyKey);
        }
        if (!reservation.result) {
          throw new IdempotencyInProgressError(idempotencyKey);
        }
        return reservation.result;
      }

      const task = await transaction.getTask(taskId);
      if (!task || task.status !== "OPEN") throw new TaskNotFoundError(taskId);
      if (!task.opportunity.contactIds.includes(command.contactId)) {
        throw new ContactNotAvailableError(command.contactId);
      }

      const taskUpdated = await transaction.completeTaskIfVersion({
        taskId,
        expectedVersion: task.version,
        outcome: command.outcome,
        completedAt: occurredAt,
      });
      if (!taskUpdated) throw new ConcurrencyConflictError("Task", taskId);

      const interactionId = this.idGenerator();
      await transaction.createInteraction({
        id: interactionId,
        opportunityId: task.opportunityId,
        taskId,
        contactId: command.contactId,
        actorId,
        interactionType: command.interactionType,
        occurredAt,
        summary: command.summary,
        outcome: command.outcome,
      });

      const nextTask = buildNextTask(task, command, this.idGenerator);
      if (nextTask) await transaction.createTask(nextTask);

      const opportunityPatch = buildOpportunityPatch(command, nextTask?.id ?? null);
      const opportunityUpdated = await transaction.updateOpportunityIfVersion({
        opportunityId: task.opportunityId,
        expectedVersion: task.opportunity.version,
        patch: opportunityPatch,
      });
      if (!opportunityUpdated) {
        throw new ConcurrencyConflictError("Opportunity", task.opportunityId);
      }

      if (opportunityPatch.stageCode && opportunityPatch.stageCode !== task.opportunity.stageCode) {
        await transaction.createStageHistory({
          id: this.idGenerator(),
          opportunityId: task.opportunityId,
          actorId,
          fromStage: task.opportunity.stageCode,
          toStage: opportunityPatch.stageCode,
          reason: command.outcome,
          occurredAt,
        });
      }

      const before = {
        task: { id: task.id, status: task.status, version: task.version },
        opportunity: {
          id: task.opportunityId,
          status: task.opportunity.status,
          stageCode: task.opportunity.stageCode,
          nextTaskId: task.opportunity.nextTaskId,
          version: task.opportunity.version,
        },
      };
      const after = {
        task: { id: task.id, status: "COMPLETED", version: task.version + 1 },
        interaction: {
          id: interactionId,
          contactId: command.contactId,
          type: command.interactionType,
          outcome: command.outcome,
          summary: command.summary,
          occurredAt: occurredAt.toISOString(),
        },
        opportunity: {
          id: task.opportunityId,
          ...opportunityPatch,
          version: task.opportunity.version + 1,
        },
      };

      await transaction.createAuditLog({
        id: this.idGenerator(),
        actorId,
        entityId: taskId,
        occurredAt,
        before,
        after,
      });

      const outboxEventId = this.idGenerator();
      await transaction.createOutboxEvent({
        id: outboxEventId,
        taskId,
        aggregateVersion: task.version + 1,
        occurredAt,
        payload: {
          taskId,
          opportunityId: task.opportunityId,
          interactionId,
          contactId: command.contactId,
          actorId,
          interactionType: command.interactionType,
          outcome: command.outcome,
          nextMode: command.next.mode,
          nextTaskId: nextTask?.id ?? null,
        },
      });

      const result = {
        taskId,
        opportunityId: task.opportunityId,
        nextTaskId: nextTask?.id ?? null,
        outboxEventId,
      };
      await transaction.completeIdempotency({
        recordId: reservation.recordId,
        result,
        completedAt: occurredAt,
      });
      return result;
    });
  }
}

function buildNextTask(
  task: CompletionTaskRecord,
  command: CompleteTaskCommand,
  idGenerator: () => string,
): NewTaskRecord | null {
  if (command.next.mode === "close") return null;

  const isWaiting = command.next.mode === "waiting";
  const dueAt = new Date(
    command.next.mode === "waiting" ? command.next.reviewAt : command.next.dueAt,
  );
  const title =
    command.next.mode === "waiting"
      ? `Вернуться к ожиданию: ${command.next.waitingFor}`
      : command.next.title;
  const priority = calculatePriority({
    partnerScore: task.opportunity.score,
    isIntegrationOrPilot: ["S7", "S8"].includes(task.opportunity.stageCode),
    isWaitingBeforeReview: isWaiting,
  });

  return {
    id: idGenerator(),
    opportunityId: task.opportunityId,
    ownerId: task.ownerId,
    type: isWaiting ? "review" : "follow-up",
    title,
    dueAt,
    priorityScore: priority.score,
    priorityReasons: priority.reasons,
    source: "task-completion",
  };
}

function buildOpportunityPatch(
  command: CompleteTaskCommand,
  nextTaskId: string | null,
): OpportunityCompletionPatch {
  if (command.next.mode === "task") {
    return {
      nextTaskId,
      status: "ACTIVE",
      waitingReason: null,
      waitingFor: null,
      reviewAt: null,
      closeReason: null,
      closeComment: null,
      returnAt: null,
    };
  }

  if (command.next.mode === "waiting") {
    return {
      nextTaskId,
      status: "WAITING",
      waitingReason: command.next.waitingReason,
      waitingFor: command.next.waitingFor,
      reviewAt: new Date(command.next.reviewAt),
      closeReason: null,
      closeComment: null,
      returnAt: null,
    };
  }

  return {
    nextTaskId: null,
    status: "CLOSED",
    stageCode: "SL",
    stageLabel: "Закрыт без запуска",
    waitingReason: null,
    waitingFor: null,
    reviewAt: null,
    closeReason: command.next.closeReason,
    closeComment: command.next.comment,
    returnAt: command.next.returnAt ? new Date(command.next.returnAt) : null,
  };
}
