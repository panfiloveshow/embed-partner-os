import type { RescheduleTaskCommand } from "@embed-os/contracts";
import { DomainRuleError } from "./task-completion.js";

export function parseRescheduleTaskCommand(input: unknown): RescheduleTaskCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw rescheduleError({ command: "Укажите новый срок и причину переноса" });
  }
  const command = input as Record<string, unknown>;
  const dueAt = typeof command.dueAt === "string" ? new Date(command.dueAt) : null;
  const reason = typeof command.reason === "string" ? command.reason.trim() : "";
  const fieldErrors: Record<string, string> = {};
  if (!dueAt || !Number.isFinite(dueAt.getTime())) {
    fieldErrors.dueAt = "Укажите корректные дату и время";
  }
  if (!reason) fieldErrors.reason = "Причина переноса обязательна";
  if (reason.length > 1_000) fieldErrors.reason = "Максимум 1000 символов";
  if (Object.keys(fieldErrors).length > 0 || !dueAt) throw rescheduleError(fieldErrors);
  return { dueAt: dueAt.toISOString(), reason };
}

export function assertLaterDeadline(currentDueAt: string | Date, nextDueAt: string) {
  if (new Date(nextDueAt).getTime() <= new Date(currentDueAt).getTime()) {
    throw rescheduleError({ dueAt: "Новый срок должен быть позже текущего" });
  }
}

function rescheduleError(fieldErrors: Record<string, string>) {
  return new DomainRuleError(
    "TSK-005",
    "Перенос срока требует новую дату и причину",
    fieldErrors,
  );
}
