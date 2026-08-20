import {
  opportunityStageCatalog,
  slaWorkingStageCodes,
  type SlaSettingsPayload,
  type SlaWorkingStageCode,
  type UpdateSlaSettingsCommand,
} from "@embed-os/contracts";
import { DomainRuleError } from "./task-completion.js";

export const defaultSlaThresholds: Record<SlaWorkingStageCode, number> = {
  S0: 2,
  S1: 2,
  S2: 3,
  S3: 3,
  S4: 5,
  S5: 5,
  S6: 5,
  S7: 7,
  S8: 7,
  S9: 14,
  S10: 14,
};

export function parseUpdateSlaSettingsCommand(input: unknown): UpdateSlaSettingsCommand {
  if (!isRecord(input)) throw validationError({ command: "Передайте настройки SLA" });
  const thresholdsInput = input.thresholds;
  if (!isRecord(thresholdsInput)) {
    throw validationError({ thresholds: "Укажите порог для каждой рабочей стадии" });
  }
  const fieldErrors: Record<string, string> = {};
  const thresholds = {} as Record<SlaWorkingStageCode, number>;
  for (const code of slaWorkingStageCodes) {
    const value = thresholdsInput[code];
    if (!validDays(value)) {
      fieldErrors[`thresholds.${code}`] = "Введите целое число от 1 до 365 дней";
    } else {
      thresholds[code] = value;
    }
  }
  if (Object.keys(fieldErrors).length > 0) throw validationError(fieldErrors);
  return {
    version: positiveVersion(input.version),
    escalationAfterDays: days(input.escalationAfterDays, "escalationAfterDays"),
    thresholds,
    reason: requiredReason(input.reason),
  };
}

export function slaSettingsFromProcessDefinition(input: {
  id: string;
  version: number;
  publishedAt: Date;
  schema: unknown;
  affectedOpportunities: number;
}): SlaSettingsPayload {
  const sla = isRecord(input.schema) && isRecord(input.schema.sla) ? input.schema.sla : {};
  const configured = isRecord(sla.thresholds) ? sla.thresholds : {};
  const escalationAfterDays = validDays(sla.escalationAfterDays)
    ? sla.escalationAfterDays
    : 3;
  return {
    processDefinitionId: input.id,
    version: input.version,
    publishedAt: input.publishedAt.toISOString(),
    escalationAfterDays,
    stages: slaWorkingStageCodes.map((code) => ({
      code,
      label: opportunityStageCatalog.find((stage) => stage.code === code)?.label ?? code,
      thresholdDays: validDays(configured[code])
        ? configured[code]
        : defaultSlaThresholds[code],
    })),
    affectedOpportunities: input.affectedOpportunities,
  };
}

export function processSchemaWithSla(
  schema: unknown,
  command: UpdateSlaSettingsCommand,
): Record<string, unknown> {
  const current = isRecord(schema) ? schema : {};
  return {
    ...current,
    sla: {
      escalationAfterDays: command.escalationAfterDays,
      thresholds: { ...command.thresholds },
    },
  };
}

function positiveVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw validationError({ version: "Обновите страницу: версия настроек некорректна" });
  }
  return value;
}

function days(value: unknown, field: string) {
  if (!validDays(value)) {
    throw validationError({ [field]: "Введите целое число от 1 до 365 дней" });
  }
  return value;
}

function requiredReason(value: unknown) {
  if (typeof value !== "string" || value.trim().length < 5 || value.trim().length > 500) {
    throw validationError({ reason: "Укажите причину изменения: от 5 до 500 символов" });
  }
  return value.trim();
}

function validDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 365;
}

function validationError(fieldErrors: Record<string, string>) {
  return new DomainRuleError(
    "SLA_SETTINGS_INVALID",
    "Настройки SLA не сохранены: исправьте отмеченные поля",
    fieldErrors,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
