import { describe, expect, it } from "vitest";
import { DomainRuleError } from "@embed-os/domain";
import { TodayService } from "./today.service.js";

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
    const after = service.rescheduleTask(
      "task-11",
      { dueAt: "2026-08-25T12:00:00+03:00", reason: "Партнёр перенёс встречу" },
      "test-key-task-reschedule-0001",
    );

    expect(after.actions.find(({ id }) => id === "task-11")?.dueAt).toBe(
      "2026-08-25T09:00:00.000Z",
    );
    expect(after.summary.rescheduled).toBe(before.summary.rescheduled + 1);
    const replay = service.rescheduleTask(
      "task-11",
      { dueAt: "2026-08-25T12:00:00+03:00", reason: "Партнёр перенёс встречу" },
      "test-key-task-reschedule-0001",
    );
    expect(replay.summary.rescheduled).toBe(after.summary.rescheduled);
  });
});
