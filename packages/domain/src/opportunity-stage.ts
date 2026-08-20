import {
  opportunityStageCatalog,
  type OpportunityStageData,
  type OpportunityStageCode,
  type TransitionOpportunityStageCommand,
} from "@embed-os/contracts";
import { DomainRuleError } from "./task-completion.js";

const STAGE_CODES = new Set<OpportunityStageCode>(
  opportunityStageCatalog.map(({ code }) => code),
);
const WORKING_STAGES: OpportunityStageCode[] = [
  "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10",
];
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface OpportunityStageReadinessFacts {
  primaryDomain: string | null;
  topic: string | null;
  score: number | null;
  ownerId: string | null;
  hasNextAction: boolean;
  hasContactOrChannel: boolean;
  latestInteraction: {
    occurredAt: string | null;
    type: string | null;
    outcome: string | null;
  } | null;
  hasActivePlacement: boolean;
  hasLaunchedPlacement: boolean;
  hasHealthyMonitoredPlacement: boolean;
  hasPlacementOwner: boolean;
}

export function parseTransitionOpportunityStageCommand(
  input: unknown,
): TransitionOpportunityStageCommand {
  if (!isRecord(input)) throw stageError({ command: "Передайте параметры перехода" });
  const version = positiveVersion(input.version);
  const toStageCode = stageCode(input.toStageCode);
  const reason = requiredText(input.reason, "reason", 1_000);
  const stageData = parseOpportunityStageData(input.stageData);
  const base = {
    version,
    toStageCode,
    reason,
    ...(Object.keys(stageData).length > 0 ? { stageData } : {}),
  };

  if (toStageCode === "SX") {
    return {
      ...base,
      pauseReason: requiredText(input.pauseReason, "pauseReason", 1_000),
      reviewAt: requiredDate(input.reviewAt, "reviewAt"),
    };
  }
  if (toStageCode === "SL") {
    const returnAt = optionalDate(input.returnAt, "returnAt");
    const neverReturn = input.neverReturn === true;
    if ((!returnAt && !neverReturn) || (returnAt && neverReturn)) {
      throw new DomainRuleError(
        "BR-006",
        "Для закрытия укажите дату возможного возврата либо признак «не возвращать»",
        { returnAt: "Выберите дату возврата или отметьте «не возвращать»" },
      );
    }
    return {
      ...base,
      closeReason: requiredText(input.closeReason, "closeReason", 300),
      closeComment: requiredText(input.closeComment, "closeComment", 1_000),
      ...(returnAt ? { returnAt } : {}),
      ...(neverReturn ? { neverReturn: true } : {}),
    };
  }
  return base;
}

export function assertOpportunityTransitionAllowed(
  fromStageCode: OpportunityStageCode,
  toStageCode: OpportunityStageCode,
  resumeStageCode: OpportunityStageCode | null,
) {
  let allowed: OpportunityStageCode[];
  if (fromStageCode === "SL") {
    allowed = [];
  } else if (fromStageCode === "SX") {
    allowed = [...(resumeStageCode ? [resumeStageCode] : []), "SL"];
  } else {
    const index = WORKING_STAGES.indexOf(fromStageCode);
    const next = WORKING_STAGES[index + 1];
    allowed = [
      ...(next ? [next] : []),
      "SX",
      ...(index <= WORKING_STAGES.indexOf("S8") ? ["SL" as const] : []),
    ];
  }
  if (!allowed.includes(toStageCode)) {
    throw stageError({
      toStageCode: allowed.length > 0
        ? `Допустимые переходы: ${allowed.join(", ")}`
        : "Из этой стадии переходы запрещены",
    });
  }
}

export function opportunityStageLabel(code: OpportunityStageCode) {
  return opportunityStageCatalog.find((stage) => stage.code === code)?.label ?? code;
}

export function parseOpportunityStageData(input: unknown): OpportunityStageData {
  if (input === undefined || input === null) return {};
  if (!isRecord(input)) throw stageError({ stageData: "Передайте объект данных стадии" });
  return compact({
    geography: optionalText(input.geography, "stageData.geography", 200),
    videoPlayerType: optionalText(input.videoPlayerType, "stageData.videoPlayerType", 200),
    dataSource: optionalText(input.dataSource, "stageData.dataSource", 500),
    researchCheckedAt: optionalDate(input.researchCheckedAt, "stageData.researchCheckedAt"),
    priorityReason: optionalText(input.priorityReason, "stageData.priorityReason", 1_000),
    rutubeUseCase: optionalText(input.rutubeUseCase, "stageData.rutubeUseCase", 1_000),
    need: optionalText(input.need, "stageData.need", 1_000),
    stakeholders: optionalTextList(input.stakeholders, "stageData.stakeholders", 20, 200),
    objections: optionalText(input.objections, "stageData.objections", 1_000),
    agreedDueAt: optionalDate(input.agreedDueAt, "stageData.agreedDueAt"),
    testUrl: optionalHttpUrl(input.testUrl, "stageData.testUrl"),
    technicalContact: optionalText(input.technicalContact, "stageData.technicalContact", 300),
    embedType: optionalEmbedType(input.embedType),
    integrationChecklist: optionalTextList(
      input.integrationChecklist,
      "stageData.integrationChecklist",
      30,
      300,
    ),
    launchDueAt: optionalDate(input.launchDueAt, "stageData.launchDueAt"),
    pilotStartsAt: optionalDate(input.pilotStartsAt, "stageData.pilotStartsAt"),
    pilotEndsAt: optionalDate(input.pilotEndsAt, "stageData.pilotEndsAt"),
    successCriteria: optionalText(input.successCriteria, "stageData.successCriteria", 1_000),
    pilotReviewAt: optionalDate(input.pilotReviewAt, "stageData.pilotReviewAt"),
    metricsSource: optionalText(input.metricsSource, "stageData.metricsSource", 500),
    competitorAlternative: optionalText(
      input.competitorAlternative,
      "stageData.competitorAlternative",
      500,
    ),
  });
}

export function assertOpportunityStageReady(
  toStageCode: OpportunityStageCode,
  stageData: OpportunityStageData,
  facts: OpportunityStageReadinessFacts,
) {
  const fieldErrors: Record<string, string> = {};
  const requireText = (field: keyof OpportunityStageData, label: string) => {
    const value = stageData[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      fieldErrors[`stageData.${field}`] = `Заполните поле «${label}»`;
    }
  };
  const requireList = (field: keyof OpportunityStageData, label: string) => {
    const value = stageData[field];
    if (!Array.isArray(value) || value.length === 0) {
      fieldErrors[`stageData.${field}`] = `Добавьте хотя бы одно значение: ${label}`;
    }
  };

  if (toStageCode === "S1") {
    if (!facts.primaryDomain) fieldErrors.primaryDomain = "Укажите основной домен организации";
    if (!facts.topic) fieldErrors.topic = "Укажите тематику организации";
    requireText("geography", "География");
    requireText("videoPlayerType", "Тип видеоплеера");
    requireText("dataSource", "Источник данных");
    requireText("researchCheckedAt", "Дата проверки");
  }
  if (toStageCode === "S2") {
    if (facts.score === null || facts.score <= 0) fieldErrors.score = "Рассчитайте Partner Score";
    requireText("priorityReason", "Причина приоритета");
    requireText("rutubeUseCase", "Предполагаемый кейс RUTUBE");
    if (!facts.ownerId) fieldErrors.owner = "Назначьте владельца возможности";
    if (!facts.hasNextAction) fieldErrors.nextAction = "Создайте следующее действие";
  }
  if (toStageCode === "S3") {
    if (!facts.hasContactOrChannel) fieldErrors.contactOrChannel = "Укажите контакт или канал связи";
    if (!facts.latestInteraction?.occurredAt) fieldErrors.interactionAt = "Зафиксируйте дату контакта";
    if (!facts.latestInteraction?.type) fieldErrors.interactionType = "Укажите тип взаимодействия";
    if (!facts.latestInteraction?.outcome) fieldErrors.interactionOutcome = "Зафиксируйте результат контакта";
    if (!facts.hasNextAction) fieldErrors.nextAction = "Создайте следующий шаг";
  }
  if (toStageCode === "S4") {
    requireText("need", "Потребность");
    requireList("stakeholders", "Заинтересованные лица");
    requireText("objections", "Возражения или отметка об их отсутствии");
    requireText("agreedDueAt", "Согласованный срок");
  }
  if (toStageCode === "S7") {
    requireText("testUrl", "Тестовый URL");
    requireText("technicalContact", "Технический контакт");
    requireText("embedType", "Тип эмбеда");
    requireList("integrationChecklist", "Чек-лист интеграции");
    requireText("launchDueAt", "Срок запуска");
  }
  if (toStageCode === "S8") {
    requireText("pilotStartsAt", "Начало периода пилота");
    requireText("pilotEndsAt", "Окончание периода пилота");
    requireText("successCriteria", "Критерии успеха");
    requireText("pilotReviewAt", "Контрольная дата");
    requireText("metricsSource", "Источник метрик");
  }
  if (toStageCode === "S9") {
    if (!facts.hasActivePlacement) fieldErrors.activePlacement = "Добавьте активное размещение";
    if (!facts.hasLaunchedPlacement) fieldErrors.launchedAt = "Укажите дату запуска размещения";
    if (!facts.hasHealthyMonitoredPlacement) {
      fieldErrors.monitoring = "Получите успешную L0-проверку активного размещения";
    }
    if (!facts.hasPlacementOwner) fieldErrors.responsible = "Назначьте ответственного за размещение";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new DomainRuleError(
      toStageCode === "S9" ? "BR-007" : "BR-003",
      toStageCode === "S9"
        ? "Переход в «Активный» требует готового размещения"
        : "Переход стадии заблокирован: заполните обязательные данные",
      fieldErrors,
    );
  }
}

function stageCode(value: unknown): OpportunityStageCode {
  if (typeof value !== "string" || !STAGE_CODES.has(value as OpportunityStageCode)) {
    throw stageError({ toStageCode: "Выберите стадию из опубликованной воронки" });
  }
  return value as OpportunityStageCode;
}

function positiveVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw stageError({ version: "Укажите положительную целую версию возможности" });
  }
  return value;
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw stageError({ [field]: `Поле обязательно, не более ${maxLength} символов` });
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw stageError({ [field]: `Не более ${maxLength} символов` });
  }
  return value.trim() || undefined;
}

function optionalTextList(
  value: unknown,
  field: string,
  maxItems: number,
  maxItemLength: number,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw stageError({ [field]: `Передайте список не более чем из ${maxItems} значений` });
  }
  const normalized = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0 || item.trim().length > maxItemLength) {
      throw stageError({ [field]: `Каждое значение обязательно, не более ${maxItemLength} символов` });
    }
    return item.trim();
  });
  return [...new Set(normalized)];
}

function optionalHttpUrl(value: unknown, field: string): string | undefined {
  const normalized = optionalText(value, field, 2_000);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    throw stageError({ [field]: "Укажите корректный HTTP(S) URL" });
  }
}

function optionalEmbedType(value: unknown): OpportunityStageData["embedType"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "video" && value !== "live" && value !== "playlist") {
    throw stageError({ "stageData.embedType": "Выберите video, live или playlist" });
  }
  return value;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function requiredDate(value: unknown, field: string) {
  const parsed = optionalDate(value, field);
  if (!parsed) throw stageError({ [field]: "Укажите дату и время с часовым поясом" });
  return parsed;
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ISO_WITH_TIMEZONE.test(value) || Number.isNaN(Date.parse(value))) {
    throw stageError({ [field]: "Укажите ISO 8601 дату и время с часовым поясом" });
  }
  return new Date(value).toISOString();
}

function stageError(fieldErrors: Record<string, string>) {
  return new DomainRuleError("BR-003", "Переход стадии заблокирован", fieldErrors);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
