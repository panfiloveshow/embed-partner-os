import {
  manualInteractionTypes,
  type CompleteTaskCommand,
  type ManualInteractionType,
} from "@embed-os/contracts";

export class DomainRuleError extends Error {
  readonly code: string;
  readonly fieldErrors: Record<string, string>;

  constructor(code: string, message: string, fieldErrors: Record<string, string>) {
    super(message);
    this.name = "DomainRuleError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function parseCompleteTaskCommand(input: unknown): CompleteTaskCommand {
  if (!isRecord(input)) {
    throw validationError({ command: "Передайте результат и следующий шаг" });
  }

  const outcome = requiredText(input.outcome, "outcome", 200);
  const summary = requiredText(input.summary, "summary", 4_000);

  if (!isRecord(input.next) || typeof input.next.mode !== "string") {
    throw validationError({ next: "Выберите следующий шаг, ожидание или закрытие" });
  }
  const contactId = requiredContactId(input.contactId);
  const interactionType = requiredInteractionType(input.interactionType);

  if (input.next.mode === "task") {
    return {
      contactId,
      interactionType,
      outcome,
      summary,
      next: {
        mode: "task",
        title: requiredText(input.next.title, "next.title", 200),
        dueAt: requiredDate(input.next.dueAt, "next.dueAt"),
      },
    };
  }

  if (input.next.mode === "waiting") {
    return {
      contactId,
      interactionType,
      outcome,
      summary,
      next: {
        mode: "waiting",
        waitingReason: requiredText(input.next.waitingReason, "next.waitingReason", 1_000),
        waitingFor: requiredText(input.next.waitingFor, "next.waitingFor", 200),
        reviewAt: requiredDate(input.next.reviewAt, "next.reviewAt"),
      },
    };
  }

  if (input.next.mode === "close") {
    const neverReturn = input.next.neverReturn === true;
    const returnAt = neverReturn
      ? undefined
      : requiredDate(input.next.returnAt, "next.returnAt");

    return {
      contactId,
      interactionType,
      outcome,
      summary,
      next: {
        mode: "close",
        closeReason: requiredText(input.next.closeReason, "next.closeReason", 200),
        comment: requiredText(input.next.comment, "next.comment", 1_000),
        ...(returnAt ? { returnAt } : {}),
        ...(neverReturn ? { neverReturn: true } : {}),
      },
    };
  }

  throw validationError({ "next.mode": "Неизвестный вариант завершения" });
}

function requiredContactId(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainRuleError(
      "TSK-008",
      "Выберите контакт для фиксации взаимодействия",
      { contactId: "Выберите контакт, связанный с организацией" },
    );
  }
  if (value.trim().length > 200) {
    throw new DomainRuleError(
      "TSK-008",
      "Некорректный идентификатор контакта",
      { contactId: "Идентификатор контакта слишком длинный" },
    );
  }
  return value.trim();
}

function requiredInteractionType(value: unknown): ManualInteractionType {
  if (
    typeof value !== "string" ||
    !manualInteractionTypes.includes(value as ManualInteractionType)
  ) {
    throw new DomainRuleError(
      "TSK-008",
      "Выберите тип взаимодействия для фиксации контакта",
      { interactionType: "Выберите письмо, звонок, встречу, мессенджер или заметку" },
    );
  }
  return value as ManualInteractionType;
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError({ [field]: "Поле обязательно" });
  }
  if (value.trim().length > maxLength) {
    throw validationError({ [field]: `Максимум ${maxLength} символов` });
  }
  return value.trim();
}

function requiredDate(value: unknown, field: string) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw validationError({ [field]: "Укажите корректную дату и время" });
  }
  return new Date(value).toISOString();
}

function validationError(fieldErrors: Record<string, string>) {
  return new DomainRuleError(
    "BR-002",
    "Активная возможность не может остаться без следующего действия",
    fieldErrors,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
