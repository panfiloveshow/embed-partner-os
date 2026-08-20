import { describe, expect, it } from "vitest";
import { DomainRuleError, parseCompleteTaskCommand } from "./task-completion.js";

describe("parseCompleteTaskCommand", () => {
  it("accepts a result together with a valid next task", () => {
    expect(
      parseCompleteTaskCommand({
        contactId: "contact-1",
        interactionType: "email",
        outcome: "Получена спецификация",
        summary: "Партнёр подтвердил готовность к тесту",
        next: {
          mode: "task",
          title: "Передать параметры интеграции",
          dueAt: "2026-08-18T09:00:00+03:00",
        },
      }),
    ).toMatchObject({
      contactId: "contact-1",
      interactionType: "email",
      outcome: "Получена спецификация",
      next: { mode: "task" },
    });
  });

  it("rejects completion without a next-state decision", () => {
    expect(() =>
      parseCompleteTaskCommand({ outcome: "Готово", summary: "Результат сохранён" }),
    ).toThrowError(DomainRuleError);
  });

  it("requires all waiting fields", () => {
    expect(() =>
      parseCompleteTaskCommand({
        contactId: "contact-1",
        interactionType: "call",
        outcome: "Ждём",
        summary: "Документы у партнёра",
        next: { mode: "waiting", waitingReason: "Согласование" },
      }),
    ).toThrowError(/следующего действия/);
  });

  it("requires a supported manual interaction type", () => {
    expect(() =>
      parseCompleteTaskCommand({
        contactId: "contact-1",
        interactionType: "system-event",
        outcome: "Получен ответ",
        summary: "Партнёр прислал информацию",
        next: {
          mode: "task",
          title: "Подготовить ответ",
          dueAt: "2026-08-18T09:00:00+03:00",
        },
      }),
    ).toThrowError(/тип взаимодействия/i);
  });

  it("requires a contact for a manual interaction", () => {
    expect(() =>
      parseCompleteTaskCommand({
        interactionType: "email",
        outcome: "Получен ответ",
        summary: "Партнёр прислал информацию",
        next: {
          mode: "task",
          title: "Подготовить ответ",
          dueAt: "2026-08-18T09:00:00+03:00",
        },
      }),
    ).toThrowError(/контакт/i);
  });
});
