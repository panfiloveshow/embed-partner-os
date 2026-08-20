import type {
  ChangeContactStatusCommand,
  CreateContactCommand,
  LinkContactCommand,
  MergeContactCommand,
  UpdateContactCommand,
} from "@embed-os/contracts";
import { DomainRuleError } from "./task-completion.js";

export function parseCreateContactCommand(input: unknown): CreateContactCommand {
  if (!isRecord(input)) {
    throw contactValidationError({ contact: "Передайте данные контакта" });
  }

  const fullName = requiredText(input.fullName, "fullName", 200);
  const role = requiredText(input.role, "role", 200);
  const department = optionalText(input.department, "department", 200);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const messenger = normalizeMessenger(input.messenger);
  const source = optionalText(input.source, "source", 200);
  const verifiedAt = optionalDate(input.verifiedAt, "verifiedAt");
  const restrictions = optionalText(input.restrictions, "restrictions", 2_000);

  if (!email && !phone && !messenger) {
    throw contactValidationError({
      channels: "Укажите хотя бы один рабочий канал: email, телефон или мессенджер",
    });
  }

  return {
    fullName,
    role,
    ...(department ? { department } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(messenger ? { messenger } : {}),
    ...(source ? { source } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(restrictions ? { restrictions } : {}),
  };
}

export function parseUpdateContactCommand(input: unknown): UpdateContactCommand {
  if (!isRecord(input)) {
    throw contactValidationError({ contact: "Передайте данные контакта" });
  }

  const version = positiveVersion(input.version);
  const fullName = requiredText(input.fullName, "fullName", 200);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const messenger = normalizeMessenger(input.messenger);
  const source = requiredText(input.source, "source", 200);
  const verifiedAt = optionalDate(input.verifiedAt, "verifiedAt");
  const restrictions = optionalText(input.restrictions, "restrictions", 2_000);

  if (!email && !phone && !messenger) {
    throw contactValidationError({
      channels: "Укажите хотя бы один рабочий канал: email, телефон или мессенджер",
    });
  }

  let organizationLink: UpdateContactCommand["organizationLink"];
  if (input.organizationLink !== undefined && input.organizationLink !== null) {
    if (!isRecord(input.organizationLink)) {
      throw contactValidationError({ organizationLink: "Передайте данные связи с организацией" });
    }
    const id = requiredText(input.organizationLink.id, "organizationLink.id", 200);
    const role = requiredText(input.organizationLink.role, "organizationLink.role", 200);
    const department = optionalText(
      input.organizationLink.department,
      "organizationLink.department",
      200,
    );
    organizationLink = { id, role, ...(department ? { department } : {}) };
  }

  return {
    version,
    fullName,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(messenger ? { messenger } : {}),
    source,
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(restrictions ? { restrictions } : {}),
    ...(organizationLink ? { organizationLink } : {}),
  };
}

export function parseChangeContactStatusCommand(input: unknown): ChangeContactStatusCommand {
  if (!isRecord(input)) {
    throw contactValidationError({ contact: "Передайте версию и причину" });
  }
  return {
    version: positiveVersion(input.version),
    reason: requiredText(input.reason, "reason", 1_000),
  };
}

export function parseLinkContactCommand(input: unknown): LinkContactCommand {
  if (!isRecord(input)) {
    throw linkValidationError({ link: "Передайте роль контакта в организации" });
  }
  const role = linkRequiredText(input.role, "role", 200);
  const department = linkOptionalText(input.department, "department", 200);
  return { role, ...(department ? { department } : {}) };
}

export function parseMergeContactCommand(input: unknown): MergeContactCommand {
  if (!isRecord(input)) {
    throw mergeValidationError({ merge: "Передайте целевой контакт и причину слияния" });
  }
  const targetContactId = mergeRequiredText(input.targetContactId, "targetContactId", 200);
  const reason = mergeRequiredText(input.reason, "reason", 1_000);
  return { targetContactId, reason };
}

function normalizeEmail(value: unknown) {
  const email = optionalText(value, "email", 320)?.toLowerCase();
  if (!email) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw contactValidationError({ email: "Укажите корректный email" }, "Некорректный email контакта");
  }
  return email;
}

function normalizePhone(value: unknown) {
  const raw = optionalText(value, "phone", 100);
  if (!raw) return undefined;

  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length < 10 || digits.length > 15) {
    throw contactValidationError({ phone: "Укажите корректный телефон" });
  }
  return `+${digits}`;
}

function normalizeMessenger(value: unknown) {
  const raw = optionalText(value, "messenger", 100)?.toLowerCase();
  if (!raw) return undefined;
  const handle = raw.replace(/^@+/, "");
  if (!/^[a-z0-9][a-z0-9._-]{1,98}$/.test(handle)) {
    throw contactValidationError({ messenger: "Укажите корректный логин мессенджера" });
  }
  return `@${handle}`;
}

function optionalDate(value: unknown, field: string) {
  const raw = optionalText(value, field, 100);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw contactValidationError({ [field]: "Укажите корректную дату и время" });
  }
  return parsed.toISOString();
}

function positiveVersion(value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw contactValidationError({ version: "Версия должна быть положительным целым числом" });
  }
  return value as number;
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw contactValidationError({ [field]: "Поле обязательно" });
  }
  if (value.trim().length > maxLength) {
    throw contactValidationError({ [field]: `Максимум ${maxLength} символов` });
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw contactValidationError({ [field]: "Ожидается текст" });
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw contactValidationError({ [field]: `Максимум ${maxLength} символов` });
  }
  return normalized;
}

function contactValidationError(
  fieldErrors: Record<string, string>,
  message = "Контакт должен содержать имя, роль и хотя бы один рабочий канал",
) {
  return new DomainRuleError(
    "PRT-005",
    message,
    fieldErrors,
  );
}

function linkRequiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw linkValidationError({ [field]: "Роль в организации обязательна" });
  }
  if (value.trim().length > maxLength) {
    throw linkValidationError({ [field]: `Максимум ${maxLength} символов` });
  }
  return value.trim();
}

function linkOptionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw linkValidationError({ [field]: "Ожидается текст" });
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw linkValidationError({ [field]: `Максимум ${maxLength} символов` });
  }
  return normalized;
}

function linkValidationError(fieldErrors: Record<string, string>) {
  return new DomainRuleError(
    "PRT-006",
    "Для связи контакта укажите его роль в организации",
    fieldErrors,
  );
}

function mergeRequiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw mergeValidationError({ [field]: "Поле обязательно" });
  }
  if (value.trim().length > maxLength) {
    throw mergeValidationError({ [field]: `Максимум ${maxLength} символов` });
  }
  return value.trim();
}

function mergeValidationError(fieldErrors: Record<string, string>) {
  return new DomainRuleError(
    "PRT-007",
    "Для слияния выберите целевой контакт и укажите причину",
    fieldErrors,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
