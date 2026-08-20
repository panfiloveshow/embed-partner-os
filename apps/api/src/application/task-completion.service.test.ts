import { describe, expect, it } from "vitest";
import type {
  CompletionResult,
  CompletionTaskRecord,
  CompletionTransaction,
  CompletionTransactionRunner,
  NewTaskRecord,
  OpportunityCompletionPatch,
} from "./task-completion.service.js";
import { IdempotencyConflictError } from "./idempotency.js";
import {
  ContactNotAvailableError,
  ConcurrencyConflictError,
  TaskCompletionApplicationService,
} from "./task-completion.service.js";

const NOW = new Date("2026-08-17T10:00:00.000Z");

describe("TaskCompletionApplicationService", () => {
  it("commits completion, next task, audit and outbox in one transaction", async () => {
    const store = new FakeCompletionStore();
    const service = createService(store);

    const result = await service.complete(
      "task-1",
      "user-1",
      {
        contactId: "contact-1",
        interactionType: "email",
        outcome: "Получена спецификация",
        summary: "Партнёр подтвердил состав API",
        next: {
          mode: "task",
          title: "Передать примеры интеграции",
          dueAt: "2026-08-18T12:00:00+03:00",
        },
      },
      "test-key-success-0001",
    );

    expect(store.state.task.status).toBe("COMPLETED");
    expect(store.state.task.version).toBe(4);
    expect(store.state.createdTasks).toHaveLength(1);
    expect(store.state.createdTasks[0]).toMatchObject({
      id: result.nextTaskId,
      title: "Передать примеры интеграции",
    });
    expect(store.state.opportunityPatch).toMatchObject({
      status: "ACTIVE",
      nextTaskId: result.nextTaskId,
    });
    expect(store.state.auditLogs).toHaveLength(1);
    expect(store.state.interactions[0]).toMatchObject({
      contactId: "contact-1",
      interactionType: "email",
    });
    expect(store.state.auditLogs[0]).toMatchObject({
      after: {
        interaction: {
          id: store.state.interactions[0]?.id,
          contactId: "contact-1",
          type: "email",
          outcome: "Получена спецификация",
          summary: "Партнёр подтвердил состав API",
          occurredAt: NOW.toISOString(),
        },
      },
    });
    expect(store.state.outboxEvents).toEqual([
      expect.objectContaining({
        id: result.outboxEventId,
        aggregateVersion: 4,
        payload: expect.objectContaining({
          interactionId: store.state.interactions[0]?.id,
          contactId: "contact-1",
          interactionType: "email",
          nextMode: "task",
        }),
      }),
    ]);
  });

  it("persists explicit waiting state and a single review task", async () => {
    const store = new FakeCompletionStore();
    const service = createService(store);

    await service.complete(
      "task-1",
      "user-1",
      {
        contactId: "contact-1",
        interactionType: "call",
        outcome: "Ждём решение ИБ",
        summary: "Документы переданы партнёру",
        next: {
          mode: "waiting",
          waitingReason: "Согласование безопасности",
          waitingFor: "Служба ИБ партнёра",
          reviewAt: "2026-08-21T10:00:00+03:00",
        },
      },
      "test-key-waiting-0001",
    );

    expect(store.state.createdTasks).toHaveLength(1);
    expect(store.state.createdTasks[0]).toMatchObject({
      type: "review",
      title: "Вернуться к ожиданию: Служба ИБ партнёра",
    });
    expect(store.state.opportunityPatch).toMatchObject({
      status: "WAITING",
      waitingReason: "Согласование безопасности",
      waitingFor: "Служба ИБ партнёра",
    });
  });

  it("closes the opportunity without creating an orphan next task", async () => {
    const store = new FakeCompletionStore();
    const service = createService(store);

    await service.complete(
      "task-1",
      "user-1",
      {
        contactId: "contact-1",
        interactionType: "meeting",
        outcome: "Партнёр отказался",
        summary: "Нет ресурсов на интеграцию в этом году",
        next: {
          mode: "close",
          closeReason: "Нет ресурсов",
          comment: "Вернуться после пересмотра бюджета",
          returnAt: "2027-02-01T10:00:00+03:00",
        },
      },
      "test-key-close-0001",
    );

    expect(store.state.createdTasks).toHaveLength(0);
    expect(store.state.opportunityPatch).toMatchObject({
      status: "CLOSED",
      stageCode: "SL",
      nextTaskId: null,
      closeReason: "Нет ресурсов",
    });
    expect(store.state.stageHistory).toEqual([
      expect.objectContaining({ fromStage: "S7", toStage: "SL" }),
    ]);
  });

  it("rolls the whole transaction back after an opportunity version conflict", async () => {
    const store = new FakeCompletionStore({ conflictOnOpportunity: true });
    const service = createService(store);

    await expect(
      service.complete(
        "task-1",
        "user-1",
        {
          contactId: "contact-1",
          interactionType: "messenger",
          outcome: "Получен ответ",
          summary: "Согласовали следующий созвон",
          next: {
            mode: "task",
            title: "Провести созвон",
            dueAt: "2026-08-18T12:00:00+03:00",
          },
        },
        "test-key-conflict-0001",
      ),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);

    expect(store.state.task.status).toBe("OPEN");
    expect(store.state.task.version).toBe(3);
    expect(store.state.createdTasks).toHaveLength(0);
    expect(store.state.interactions).toHaveLength(0);
    expect(store.state.stageHistory).toHaveLength(0);
    expect(store.state.auditLogs).toHaveLength(0);
    expect(store.state.outboxEvents).toHaveLength(0);
    expect(store.state.idempotencyRecords).toHaveLength(0);
  });

  it("replays the saved result without creating duplicate side effects", async () => {
    const store = new FakeCompletionStore();
    const service = createService(store);
    const command = {
      contactId: "contact-1",
      interactionType: "email" as const,
      outcome: "Получена спецификация",
      summary: "Партнёр подтвердил состав API",
      next: {
        mode: "task" as const,
        title: "Передать примеры интеграции",
        dueAt: "2026-08-18T12:00:00+03:00",
      },
    };

    const first = await service.complete("task-1", "user-1", command, "test-key-replay-0001");
    const replay = await service.complete("task-1", "user-1", command, "test-key-replay-0001");

    expect(replay).toEqual(first);
    expect(store.state.createdTasks).toHaveLength(1);
    expect(store.state.interactions).toHaveLength(1);
    expect(store.state.auditLogs).toHaveLength(1);
    expect(store.state.outboxEvents).toHaveLength(1);
    expect(store.state.idempotencyRecords).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key with a different payload", async () => {
    const store = new FakeCompletionStore();
    const service = createService(store);
    const command = {
      contactId: "contact-1",
      interactionType: "note" as const,
      outcome: "Получена спецификация",
      summary: "Партнёр подтвердил состав API",
      next: {
        mode: "task" as const,
        title: "Передать примеры интеграции",
        dueAt: "2026-08-18T12:00:00+03:00",
      },
    };

    await service.complete("task-1", "user-1", command, "test-key-reuse-0001");
    await expect(
      service.complete(
        "task-1",
        "user-1",
        { ...command, summary: "Содержимое изменено" },
        "test-key-reuse-0001",
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(store.state.interactions).toHaveLength(1);
    expect(store.state.outboxEvents).toHaveLength(1);
  });

  it("rejects a contact that is not linked to the task organization", async () => {
    const store = new FakeCompletionStore();
    const service = createService(store);

    await expect(
      service.complete(
        "task-1",
        "user-1",
        {
          contactId: "contact-from-another-organization",
          interactionType: "email",
          outcome: "Получен ответ",
          summary: "Ответ получен от другого контакта",
          next: {
            mode: "task",
            title: "Уточнить контакт",
            dueAt: "2026-08-18T12:00:00+03:00",
          },
        },
        "test-key-contact-scope-0001",
      ),
    ).rejects.toBeInstanceOf(ContactNotAvailableError);

    expect(store.state.task.status).toBe("OPEN");
    expect(store.state.interactions).toHaveLength(0);
    expect(store.state.auditLogs).toHaveLength(0);
    expect(store.state.outboxEvents).toHaveLength(0);
  });
});

function createService(store: FakeCompletionStore) {
  let sequence = 0;
  return new TaskCompletionApplicationService(
    store,
    () => NOW,
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  );
}

interface FakeState {
  task: CompletionTaskRecord;
  createdTasks: NewTaskRecord[];
  interactions: Array<Record<string, unknown>>;
  opportunityPatch: OpportunityCompletionPatch | null;
  stageHistory: Array<Record<string, unknown>>;
  auditLogs: Array<Record<string, unknown>>;
  outboxEvents: Array<Record<string, unknown>>;
  idempotencyRecords: Array<{
    id: string;
    actorId: string;
    operation: string;
    key: string;
    requestHash: string;
    result: CompletionResult | null;
  }>;
}

class FakeCompletionStore implements CompletionTransactionRunner, CompletionTransaction {
  state: FakeState = {
    task: {
      id: "task-1",
      opportunityId: "opportunity-1",
      ownerId: "user-1",
      title: "Ответить партнёру",
      status: "OPEN",
      version: 3,
      priorityScore: 92,
      opportunity: {
        contactIds: ["contact-1"],
        version: 7,
        stageCode: "S7",
        status: "ACTIVE",
        score: 85,
        nextTaskId: "task-1",
      },
    },
    createdTasks: [],
    interactions: [],
    opportunityPatch: null,
    stageHistory: [],
    auditLogs: [],
    outboxEvents: [],
    idempotencyRecords: [],
  };

  constructor(private readonly options: { conflictOnOpportunity?: boolean } = {}) {}

  async transaction<T>(work: (transaction: CompletionTransaction) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async getTask(taskId: string) {
    return taskId === this.state.task.id ? structuredClone(this.state.task) : null;
  }

  async reserveIdempotency(input: {
    id: string;
    actorId: string;
    operation: string;
    key: string;
    requestHash: string;
  }) {
    const existing = this.state.idempotencyRecords.find(
      (record) =>
        record.actorId === input.actorId &&
        record.operation === input.operation &&
        record.key === input.key,
    );
    if (existing) {
      return {
        state: "existing" as const,
        requestHash: existing.requestHash,
        result: existing.result,
      };
    }
    this.state.idempotencyRecords.push({ ...input, result: null });
    return { state: "reserved" as const, recordId: input.id };
  }

  async completeIdempotency(input: { recordId: string; result: CompletionResult }) {
    const record = this.state.idempotencyRecords.find(({ id }) => id === input.recordId);
    if (!record) throw new Error("Missing fake idempotency reservation");
    record.result = input.result;
  }

  async completeTaskIfVersion(input: {
    taskId: string;
    expectedVersion: number;
    outcome: string;
    completedAt: Date;
  }) {
    if (
      input.taskId !== this.state.task.id ||
      input.expectedVersion !== this.state.task.version ||
      this.state.task.status !== "OPEN"
    )
      return false;
    this.state.task.status = "COMPLETED";
    this.state.task.version += 1;
    return true;
  }

  async createInteraction(input: Record<string, unknown>) {
    this.state.interactions.push(input);
  }

  async createTask(input: NewTaskRecord) {
    this.state.createdTasks.push(input);
  }

  async updateOpportunityIfVersion(input: {
    opportunityId: string;
    expectedVersion: number;
    patch: OpportunityCompletionPatch;
  }) {
    if (this.options.conflictOnOpportunity) return false;
    if (input.expectedVersion !== this.state.task.opportunity.version) return false;
    this.state.opportunityPatch = input.patch;
    this.state.task.opportunity.version += 1;
    this.state.task.opportunity.status = input.patch.status;
    this.state.task.opportunity.nextTaskId = input.patch.nextTaskId;
    return true;
  }

  async createAuditLog(input: Record<string, unknown>) {
    this.state.auditLogs.push(input);
  }

  async createStageHistory(input: Record<string, unknown>) {
    this.state.stageHistory.push(input);
  }

  async createOutboxEvent(input: Record<string, unknown>) {
    this.state.outboxEvents.push(input);
  }
}
