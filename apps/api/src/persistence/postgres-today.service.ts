import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma, TaskStatus } from "@prisma/client";
import type { ActionGroup, PriorityReason, TodayAction, TodayPayload } from "@embed-os/contracts";
import {
  assertLaterDeadline,
  parseOpportunityStageData,
  parseRescheduleTaskCommand,
} from "@embed-os/domain";
import type { TodayPort } from "../today.port.js";
import { TaskCompletionApplicationService } from "../application/task-completion.service.js";
import { PrismaService } from "./prisma.service.js";
import { PrismaTaskCompletionStore } from "./prisma-task-completion.store.js";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  parseIdempotencyKey,
  taskRescheduleRequestHash,
} from "../application/idempotency.js";
import {
  ConcurrencyConflictError,
  TaskNotFoundError,
} from "../application/task-completion.service.js";
import {
  PersistenceActorService,
  taskScope,
  type PersistenceActor,
} from "./persistence-actor.service.js";

@Injectable()
export class PostgresTodayService implements TodayPort {
  private readonly completionService: TaskCompletionApplicationService;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PersistenceActorService) private readonly actors: PersistenceActorService,
  ) {
    this.completionService = new TaskCompletionApplicationService(
      new PrismaTaskCompletionStore(prisma),
    );
  }

  async getToday(): Promise<TodayPayload> {
    const now = new Date();
    const { start, end } = moscowDayBounds(now);
    const actor = await this.actors.current();
    const visibility = taskScope(actor);
    const [tasks, completed, rescheduled, stageChanges, launches] = await Promise.all([
      this.prisma.task.findMany({
        where: { ...visibility, status: TaskStatus.OPEN },
        include: {
          owner: { select: { displayName: true } },
          opportunity: {
            include: {
              organization: {
                include: {
                  domains: {
                    where: { archivedAt: null },
                    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                    take: 1,
                  },
                  contactLinks: {
                    where: {
                      validTo: null,
                      contact: { archivedAt: null, mergedIntoId: null },
                    },
                    orderBy: [{ isPrimary: "desc" }, { validFrom: "asc" }],
                    include: { contact: true },
                  },
                },
              },
              interactions: {
                orderBy: { occurredAt: "desc" },
                take: 1,
                include: { author: true, contact: true },
              },
            },
          },
        },
        orderBy: [{ priorityScore: "desc" }, { dueAt: "asc" }, { id: "asc" }],
      }),
      this.prisma.task.count({
        where: {
          ...visibility,
          status: TaskStatus.COMPLETED,
          completedAt: { gte: start, lte: end },
        },
      }),
      this.prisma.auditLog.count({
        where: {
          ...auditActorScope(actor),
          action: "task.reschedule",
          occurredAt: { gte: start, lte: end },
        },
      }),
      this.prisma.stageHistory.count({
        where: { ...historyActorScope(actor), occurredAt: { gte: start, lte: end } },
      }),
      this.prisma.stageHistory.count({
        where: {
          ...historyActorScope(actor),
          toStage: "S9",
          occurredAt: { gte: start, lte: end },
        },
      }),
    ]);

    const actions: TodayAction[] = tasks.map((task) => {
      const interaction = task.opportunity.interactions[0] ?? null;
      return {
        id: task.id,
        organizationId: task.opportunity.organizationId,
        organizationName: task.opportunity.organization.name,
        domain: task.opportunity.organization.domains[0]?.hostNormalized ?? "—",
        opportunityId: task.opportunityId,
        opportunityVersion: task.opportunity.version,
        processVersion: task.opportunity.processVersion,
        opportunityStatus: task.opportunity.status,
        partnerScore: task.opportunity.score,
        organizationSegment: task.opportunity.organization.segment,
        opportunityStageData: parseOpportunityStageData(task.opportunity.stageData),
        stageCode: task.opportunity.stageCode,
        stageLabel: task.opportunity.stageLabel,
        title: task.title,
        dueAt: task.dueAt.toISOString(),
        group: actionGroup(task.dueAt, task.priorityScore, task.opportunity.status, start, end),
        priorityScore: task.priorityScore,
        priorityReasons: parsePriorityReasons(task.priorityReasons),
        ownerName: task.owner.displayName,
        contacts: task.opportunity.organization.contactLinks.map((link) => ({
          id: link.contact.id,
          fullName: link.contact.fullName,
          role: link.role,
          department: link.department,
          email: link.contact.email,
          phone: link.contact.phone,
          messenger: link.contact.messenger,
          isPrimary: link.isPrimary,
        })),
        lastInteraction: interaction
          ? {
              type: interactionTypeLabel(interaction.type),
              occurredAt: interaction.occurredAt.toISOString(),
              contactName: interaction.contact?.fullName ?? "Контакт не указан",
              summary: interaction.summary,
              outcome: interaction.outcome,
            }
          : null,
      };
    });

    return {
      generatedAt: now.toISOString(),
      teamName:
        actor.scopeMode === "all"
          ? "Все команды"
          : actor.scopeMode === "team"
            ? (actor.teamName ?? "Без команды")
            : actor.displayName,
      currentUser: {
        id: actor.id,
        name: actor.displayName,
        initials: initials(actor.displayName),
      },
      summary: {
        critical: actions.filter((action) => action.group === "critical").length,
        today: actions.filter((action) => action.group === "today").length,
        waiting: actions.filter((action) => action.group === "waiting").length,
        completed,
        rescheduled,
        stageChanges,
        launches,
      },
      actions: actions.sort(sortActions),
    };
  }

  async completeTask(
    taskId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<TodayPayload> {
    const actor = await this.actors.current();
    const visible = await this.prisma.task.findFirst({
      where: { id: taskId, status: TaskStatus.OPEN, ...taskScope(actor) },
      select: { id: true },
    });
    if (!visible) throw new TaskNotFoundError(taskId);
    await this.completionService.complete(taskId, actor.id, input, idempotencyKey);
    return this.getToday();
  }

  async rescheduleTask(
    taskId: string,
    input: unknown,
    rawIdempotencyKey: string,
  ): Promise<TodayPayload> {
    const command = parseRescheduleTaskCommand(input);
    const idempotencyKey = parseIdempotencyKey(rawIdempotencyKey);
    const requestHash = taskRescheduleRequestHash(command);
    const operation = `task.reschedule:${taskId}`;
    const occurredAt = new Date();

    await this.prisma.$transaction(async (transaction) => {
      const actor = await this.actors.current(transaction);
      const reservationId = randomUUID();
      const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "idempotency_record" (
          "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
        ) VALUES (
          ${reservationId}::uuid,
          ${actor.id}::uuid,
          ${operation},
          ${idempotencyKey},
          ${requestHash},
          ${occurredAt},
          ${new Date(occurredAt.getTime() + 24 * 60 * 60 * 1_000)}
        )
        ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
        RETURNING "id"
      `);
      if (inserted.length === 0) {
        const replay = await transaction.idempotencyRecord.findUnique({
          where: {
            actorId_operation_requestKey: {
              actorId: actor.id,
              operation,
              requestKey: idempotencyKey,
            },
          },
        });
        if (!replay) throw new Error("Idempotency reservation disappeared");
        if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
        if (replay.responseJson === null) throw new IdempotencyInProgressError(idempotencyKey);
        return;
      }

      const task = await transaction.task.findFirst({
        where: { id: taskId, status: TaskStatus.OPEN, ...taskScope(actor) },
        select: { id: true, dueAt: true, version: true },
      });
      if (!task) throw new TaskNotFoundError(taskId);
      assertLaterDeadline(task.dueAt, command.dueAt);
      const update = await transaction.task.updateMany({
        where: { id: task.id, status: TaskStatus.OPEN, version: task.version, ...taskScope(actor) },
        data: { dueAt: new Date(command.dueAt), version: { increment: 1 } },
      });
      if (update.count !== 1) throw new ConcurrencyConflictError("Task", task.id);
      const nextVersion = task.version + 1;
      await transaction.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: actor.id,
          action: "task.reschedule",
          entityType: "Task",
          entityId: task.id,
          beforeJson: { dueAt: task.dueAt.toISOString(), version: task.version },
          afterJson: { dueAt: command.dueAt, reason: command.reason, version: nextVersion },
          occurredAt,
        },
      });
      await transaction.outboxEvent.create({
        data: {
          id: randomUUID(),
          eventType: "task.rescheduled",
          aggregateType: "Task",
          aggregateId: task.id,
          aggregateVersion: nextVersion,
          schemaVersion: 1,
          payload: {
            taskId: task.id,
            previousDueAt: task.dueAt.toISOString(),
            dueAt: command.dueAt,
            reason: command.reason,
          },
          occurredAt,
        },
      });
      await transaction.idempotencyRecord.update({
        where: { id: reservationId },
        data: {
          responseStatus: 200,
          responseJson: { taskId: task.id, dueAt: command.dueAt, version: nextVersion },
          completedAt: occurredAt,
        },
      });
    });
    return this.getToday();
  }
}

function auditActorScope(actor: PersistenceActor): Prisma.AuditLogWhereInput {
  if (actor.scopeMode === "all") return {};
  if (actor.scopeMode === "team") return { actor: { teamId: actor.teamId ?? undefined } };
  return { actorId: actor.id };
}

function historyActorScope(actor: PersistenceActor): Prisma.StageHistoryWhereInput {
  if (actor.scopeMode === "all") return {};
  if (actor.scopeMode === "team") return { actor: { teamId: actor.teamId ?? undefined } };
  return { actorId: actor.id };
}

function actionGroup(
  dueAt: Date,
  priorityScore: number,
  opportunityStatus: string,
  start: Date,
  end: Date,
): ActionGroup {
  if (opportunityStatus === "WAITING" || opportunityStatus === "PAUSED") return "waiting";
  if (dueAt < start || priorityScore >= 60) return "critical";
  if (dueAt <= end) return "today";
  return "later";
}

function sortActions(left: TodayAction, right: TodayAction) {
  const order: Record<ActionGroup, number> = {
    critical: 0,
    today: 1,
    later: 2,
    waiting: 3,
  };
  return order[left.group] - order[right.group] || right.priorityScore - left.priorityScore;
}

function parsePriorityReasons(value: unknown): PriorityReason[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { code?: unknown }).code === "string" &&
      typeof (item as { label?: unknown }).label === "string"
    ) {
      return [item as PriorityReason];
    }
    return [];
  });
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("ru-RU") ?? "")
    .join("");
}

function interactionTypeLabel(type: string) {
  const labels: Record<string, string> = {
    email: "Письмо",
    call: "Звонок",
    meeting: "Встреча",
    messenger: "Мессенджер",
    note: "Заметка",
    "system-event": "Системное событие",
  };
  return labels[type] ?? type;
}

function moscowDayBounds(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${value.year}-${value.month}-${value.day}`;
  return {
    start: new Date(`${date}T00:00:00+03:00`),
    end: new Date(`${date}T23:59:59.999+03:00`),
  };
}
