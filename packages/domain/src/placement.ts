import type {
  ArchivePlacementCommand,
  RegisterPlacementCommand,
  UpdatePlacementCommand,
} from "@embed-os/contracts";
import { DomainRuleError } from "./task-completion.js";

const EMBED_TYPES = new Set<RegisterPlacementCommand["embedType"]>([
  "video",
  "live",
  "playlist",
]);
const ENVIRONMENTS = new Set<RegisterPlacementCommand["environment"]>([
  "production",
  "staging",
  "test",
]);
const BUSINESS_STATUSES = new Set<RegisterPlacementCommand["businessStatus"]>([
  "planned",
  "active",
  "paused",
  "ended",
]);
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseRegisterPlacementCommand(input: unknown): RegisterPlacementCommand & {
  urlPattern: string;
} {
  if (!isRecord(input)) throw placementError({ command: "Передайте параметры размещения" });
  const organizationId = requiredText(input.organizationId, "organizationId", 200);
  const opportunityId = requiredText(input.opportunityId, "opportunityId", 200);
  const pageUrl = normalizedHttpUrl(input.pageUrl);
  const urlPattern = optionalText(input.urlPattern, "urlPattern", 500) ?? pageUrl;
  const embedType = enumValue(input.embedType, "embedType", EMBED_TYPES);
  const environment = enumValue(input.environment, "environment", ENVIRONMENTS);
  const businessStatus = enumValue(input.businessStatus, "businessStatus", BUSINESS_STATUSES);
  const launchedAt = optionalDate(input.launchedAt, "launchedAt");
  if (businessStatus === "active" && !launchedAt) {
    throw placementError({ launchedAt: "Для активного размещения укажите дату запуска" });
  }
  return {
    organizationId,
    opportunityId,
    pageUrl,
    urlPattern,
    embedType,
    environment,
    businessStatus,
    ...(launchedAt ? { launchedAt } : {}),
  };
}

export function parseUpdatePlacementCommand(input: unknown): UpdatePlacementCommand {
  if (!isRecord(input)) throw lifecycleError({ command: "Передайте параметры изменения" });
  const version = positiveVersion(input.version);
  const reason = requiredText(input.reason, "reason", 500);
  const command: UpdatePlacementCommand = { version, reason };
  let changedFields = 0;

  if (Object.hasOwn(input, "pageUrl")) {
    command.pageUrl = normalizedHttpUrl(input.pageUrl);
    changedFields += 1;
  }
  if (Object.hasOwn(input, "urlPattern")) {
    command.urlPattern = requiredText(input.urlPattern, "urlPattern", 500);
    changedFields += 1;
  }
  if (Object.hasOwn(input, "embedType")) {
    command.embedType = enumValue(input.embedType, "embedType", EMBED_TYPES);
    changedFields += 1;
  }
  if (Object.hasOwn(input, "environment")) {
    command.environment = enumValue(input.environment, "environment", ENVIRONMENTS);
    changedFields += 1;
  }
  if (Object.hasOwn(input, "businessStatus")) {
    command.businessStatus = enumValue(input.businessStatus, "businessStatus", BUSINESS_STATUSES);
    changedFields += 1;
  }
  if (Object.hasOwn(input, "launchedAt")) {
    command.launchedAt = input.launchedAt === null || input.launchedAt === ""
      ? null
      : optionalDate(input.launchedAt, "launchedAt") ?? null;
    changedFields += 1;
  }
  if (changedFields === 0) {
    throw lifecycleError({ command: "Укажите хотя бы одно изменяемое поле" });
  }
  return command;
}

export function parseArchivePlacementCommand(input: unknown): ArchivePlacementCommand {
  if (!isRecord(input)) throw lifecycleError({ command: "Передайте параметры архивирования" });
  return {
    version: positiveVersion(input.version),
    reason: requiredText(input.reason, "reason", 500),
  };
}

function normalizedHttpUrl(value: unknown): string {
  const raw = requiredText(value, "pageUrl", 2_000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw placementError({ pageUrl: "Укажите абсолютный HTTP(S) URL страницы" });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw placementError({ pageUrl: "Разрешён HTTP(S) URL без встроенных credentials" });
  }
  url.hash = "";
  return url.toString();
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ISO_WITH_TIMEZONE.test(value) || Number.isNaN(Date.parse(value))) {
    throw placementError({ [field]: "Укажите ISO 8601 дату и время с часовым поясом" });
  }
  return new Date(value).toISOString();
}

function enumValue<T extends string>(value: unknown, field: string, values: Set<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw placementError({ [field]: "Недопустимое значение" });
  }
  return value as T;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw placementError({ [field]: `Поле обязательно, не более ${maxLength} символов` });
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, field, maxLength);
}

function placementError(fieldErrors: Record<string, string>) {
  return new DomainRuleError("EMB-001", "Некорректные параметры размещения", fieldErrors);
}

function lifecycleError(fieldErrors: Record<string, string>) {
  return new DomainRuleError("EMB-001", "Некорректное изменение размещения", fieldErrors);
}

function positiveVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw lifecycleError({ version: "Укажите положительную целую версию размещения" });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
