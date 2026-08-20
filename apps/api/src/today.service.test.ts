import { describe, expect, it } from "vitest";
import { DomainRuleError } from "@embed-os/domain";
import { TodayService } from "./today.service.js";

const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1_000;

/** A Moscow wall-clock instant `days` days ahead of the current Moscow day. */
function moscowDateInDays(days: number, hour: number): { command: string; utc: string } {
  const moscowNow = new Date(Date.now() + MOSCOW_UTC_OFFSET_MS);
  const instant = new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate() + days,
      hour,
    ) - MOSCOW_UTC_OFFSET_MS,
  );
  const local = new Date(instant.getTime() + MOSCOW_UTC_OFFSET_MS);
  return { command: `${local.toISOString().slice(0, 19)}+03:00`, utc: instant.toISOString() };
}

describe("TodayService", () => {
  it("returns actions in operational group order", () => {
    const payload = new TodayService().getToday();
    expect(payload.summary.critical).toBe(3);
    expect(payload.summary.today).toBe(7);
    expect(payload.actions[0]?.group).toBe("critical");
    expect(payload.actions.at(-1)?.group).toBe("waiting");
  });

  it("atomically replaces a completed task with the next task", () => {
    const service = new TodayService();
    const before = service.getToday();
    const after = service.completeTask(
      "task-1",
      {
        contactId: "contact-shared-ivan",
        interactionType: "email",
        outcome: "Получена спецификация",
        summary: "Партнёр подтвердил состав API",
        next: {
          mode: "task",
          title: "Передать примеры интеграции",
          dueAt: "2026-08-18T12:00:00+03:00",
        },
      },
      "test-key-today-service-0001",
    );

    expect(after.actions.some((action) => action.id === "task-1")).toBe(false);
    expect(after.actions.some((action) => action.title === "Передать примеры интеграции")).toBe(
      true,
    );
    expect(
      after.actions.find((action) => action.title === "Передать примеры интеграции")
        ?.lastInteraction,
    ).toMatchObject({ contactName: "Иван Петров" });
    expect(after.actions).toHaveLength(before.actions.length);
    expect(after.summary.completed).toBe(before.summary.completed + 1);
  });

  it("does not mutate the queue when BR-002 validation fails", () => {
    const service = new TodayService();
    const before = service.getToday();

    expect(() =>
      service.completeTask("task-1", { outcome: "Готово" }, "test-key-today-invalid-0001"),
    ).toThrow(DomainRuleError);
    const after = service.getToday();
    expect(after.actions).toEqual(before.actions);
    expect(after.summary).toEqual(before.summary);
  });

  it("reschedules a task only with a later deadline and mandatory reason", () => {
    const service = new TodayService();
    const before = service.getToday();
    const rescheduleTo = moscowDateInDays(8, 12);
    const after = service.rescheduleTask(
      "task-11",
      { dueAt: rescheduleTo.command, reason: "Партнёр перенёс встречу" },
      "test-key-task-reschedule-0001",
    );

    expect(after.actions.find(({ id }) => id === "task-11")?.dueAt).toBe(rescheduleTo.utc);
    expect(after.summary.rescheduled).toBe(before.summary.rescheduled + 1);
    const replay = service.rescheduleTask(
      "task-11",
      { dueAt: rescheduleTo.command, reason: "Партнёр перенёс встречу" },
      "test-key-task-reschedule-0001",
    );
    expect(replay.summary.rescheduled).toBe(after.summary.rescheduled);
  });
});
