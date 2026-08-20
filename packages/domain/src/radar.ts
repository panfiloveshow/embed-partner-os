import type {
  CreateRadarCandidateCommand,
  RadarCandidateDecisionCommand,
  RadarCandidateFeatures,
  RadarConfidence,
  RadarEvidence,
  RadarScore,
  RadarScoreAdjustmentCommand,
  RadarScoreFactor,
  RadarTrafficEstimate,
} from "@embed-os/contracts";
import { DomainRuleError } from "./task-completion.js";

export const RADAR_SCORE_MODEL_VERSION = "partner-score-v1";

export interface RadarScoreInput {
  features: RadarCandidateFeatures;
  latestEvidence: RadarEvidence | null;
  duplicateOrganization: boolean;
  duplicateCandidate: boolean;
  manualAdjustment?: number;
  manualAdjustmentComment?: string | null;
  calculatedAt?: Date;
}

export function normalizeRadarTarget(value: string) {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new DomainRuleError("RAD-001", "Укажите корректный публичный URL", {
      url: "Ожидается HTTP(S)-адрес публичной страницы",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DomainRuleError("RAD-001", "Укажите корректный публичный URL", {
      url: "Поддерживаются только HTTP и HTTPS",
    });
  }
  if (url.username || url.password) {
    throw new DomainRuleError("RAD-001", "URL с учётными данными запрещён", {
      url: "Удалите логин и пароль из адреса",
    });
  }
  const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "").replace(/\.$/, "");
  if (!host.includes(".") || host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    throw new DomainRuleError("RAD-001", "Укажите публичный домен", {
      url: "Локальные адреса и IP не принимаются",
    });
  }
  const firstLabel = host.split(".")[0] ?? "";
  if (["admin", "api", "assets", "cdn", "dev", "internal", "preview", "stage", "staging", "static", "test"].includes(firstLabel)) {
    throw new DomainRuleError("RAD-002", "Технический поддомен исключён из Радара", {
      url: "Укажите публичную контентную страницу, а не технический хост",
    });
  }
  url.hostname = host;
  url.hash = "";
  return { pageUrl: url.toString(), hostNormalized: host };
}

export function parseCreateRadarCandidateCommand(input: unknown): CreateRadarCandidateCommand {
  if (!isRecord(input)) throw validation("Команда добавления кандидата должна быть объектом");
  const name = requiredText(input.name, "name", 200);
  const url = requiredText(input.url, "url", 2_000);
  normalizeRadarTarget(url);
  const source = requiredText(input.source, "source", 200);
  const publicationFrequency = optionalText(input.publicationFrequency, "publicationFrequency", 20);
  if (publicationFrequency && !["daily", "weekly", "monthly", "unknown"].includes(publicationFrequency)) {
    throw validation("Некорректная частота публикаций", {
      publicationFrequency: "Используйте daily, weekly, monthly или unknown",
    });
  }
  const estimatedVideoPagesMin = optionalNonNegativeInteger(
    input.estimatedVideoPagesMin,
    "estimatedVideoPagesMin",
  );
  const estimatedVideoPagesMax = optionalNonNegativeInteger(
    input.estimatedVideoPagesMax,
    "estimatedVideoPagesMax",
  );
  if (
    estimatedVideoPagesMin !== undefined &&
    estimatedVideoPagesMax !== undefined &&
    estimatedVideoPagesMin > estimatedVideoPagesMax
  ) {
    throw validation("Некорректный диапазон страниц с видео", {
      estimatedVideoPagesMax: "Максимум должен быть не меньше минимума",
    });
  }
  const trafficEstimate = input.trafficEstimate === undefined
    ? undefined
    : parseTrafficEstimate(input.trafficEstimate);
  if (input.contactsFound !== undefined && typeof input.contactsFound !== "boolean") {
    throw validation("Некорректный признак контакта", {
      contactsFound: "Ожидается true или false",
    });
  }
  return {
    name,
    url,
    source,
    ...(optionalText(input.topic, "topic", 200) ? { topic: optionalText(input.topic, "topic", 200) } : {}),
    ...(optionalText(input.language, "language", 40) ? { language: optionalText(input.language, "language", 40) } : {}),
    ...(optionalText(input.geography, "geography", 120) ? { geography: optionalText(input.geography, "geography", 120) } : {}),
    ...(publicationFrequency ? { publicationFrequency: publicationFrequency as RadarCandidateFeatures["publicationFrequency"] } : {}),
    ...(typeof input.contactsFound === "boolean" ? { contactsFound: input.contactsFound } : {}),
    ...(optionalText(input.cms, "cms", 120) ? { cms: optionalText(input.cms, "cms", 120) } : {}),
    ...(estimatedVideoPagesMin === undefined ? {} : { estimatedVideoPagesMin }),
    ...(estimatedVideoPagesMax === undefined ? {} : { estimatedVideoPagesMax }),
    ...(trafficEstimate ? { trafficEstimate } : {}),
  };
}

export function parseRadarDecisionCommand(input: unknown): RadarCandidateDecisionCommand {
  if (!isRecord(input)) throw validation("Команда квалификации должна быть объектом");
  const version = positiveInteger(input.version, "version");
  const decision = input.decision;
  if (decision !== "accept" && decision !== "defer" && decision !== "reject" && decision !== "merge") {
    throw validation("Выберите допустимое решение", {
      decision: "Используйте accept, defer, reject или merge",
    });
  }
  const reason = requiredText(input.reason, "reason", 1_000);
  const comment = optionalText(input.comment, "comment", 1_000);
  const deferUntil = optionalDate(input.deferUntil, "deferUntil");
  const mergeTargetId = optionalText(input.mergeTargetId, "mergeTargetId", 100);
  if (decision === "defer" && !deferUntil) {
    throw validation("Для отложенного кандидата нужен срок пересмотра", {
      deferUntil: "Укажите дату и время пересмотра",
    });
  }
  if (decision === "merge" && !mergeTargetId) {
    throw validation("Для объединения нужен целевой кандидат", {
      mergeTargetId: "Выберите канонического кандидата",
    });
  }
  return {
    version,
    decision,
    reason,
    ...(comment ? { comment } : {}),
    ...(deferUntil ? { deferUntil } : {}),
    ...(mergeTargetId ? { mergeTargetId } : {}),
  };
}

export function parseRadarScoreAdjustmentCommand(input: unknown): RadarScoreAdjustmentCommand {
  if (!isRecord(input)) throw validation("Команда корректировки score должна быть объектом");
  const version = positiveInteger(input.version, "version");
  if (!Number.isInteger(input.adjustment) || Number(input.adjustment) < -40 || Number(input.adjustment) > 40) {
    throw validation("Ручная корректировка должна быть целым числом от -40 до 40", {
      adjustment: "Укажите целое число от -40 до 40",
    });
  }
  return {
    version,
    adjustment: Number(input.adjustment),
    comment: requiredText(input.comment, "comment", 1_000),
  };
}

export function calculatePartnerScore(input: RadarScoreInput): RadarScore {
  const factors: RadarScoreFactor[] = [
    factor("traffic", "Оценка охвата", "business", trafficPoints(input.features.trafficEstimate), 24,
      trafficExplanation(input.features.trafficEstimate)),
    factor("geography", "Целевая география", "business", geographyPoints(input.features.geography), 8,
      input.features.geography ? `Указана география: ${input.features.geography}` : "География не указана"),
    factor("publishing", "Устойчивость публикаций", "business", publicationPoints(input.features.publicationFrequency), 8,
      publicationExplanation(input.features.publicationFrequency)),
    factor("topic", "Контентная тематика", "content", input.features.topic ? 10 : 0, 10,
      input.features.topic ? `Тематика: ${input.features.topic}` : "Тематика не определена"),
    factor("video-volume", "Страницы с видео", "content", videoVolumePoints(input.features.estimatedVideoPagesMax), 15,
      videoVolumeExplanation(input.features.estimatedVideoPagesMin, input.features.estimatedVideoPagesMax)),
    factor("player", "Видеоплеер", "technical", input.latestEvidence?.playerFound ? 14 : 0, 14,
      input.latestEvidence?.playerFound
        ? `Обнаружен ${input.latestEvidence.playerType ?? "видеоплеер"}`
        : "Плеер не подтверждён"),
    factor("page-access", "Доступность страницы", "technical", evidenceAccessPoints(input.latestEvidence), 3,
      evidenceExplanation(input.latestEvidence)),
    factor("cms", "CMS / технология", "technical", input.features.cms ? 3 : 0, 3,
      input.features.cms ? `Определено: ${input.features.cms}` : "Технология не определена"),
    factor("contacts", "Контактность", "contact", input.features.contactsFound ? 15 : 0, 15,
      input.features.contactsFound ? "Найден релевантный контакт" : "Контакт не найден"),
  ];
  if (input.duplicateOrganization) {
    factors.push(factor("duplicate-partner", "Действующий партнёр", "risk", -40, -40,
      "Домен уже есть в реестре организаций"));
  } else if (input.duplicateCandidate) {
    factors.push(factor("duplicate-candidate", "Дубль кандидата", "risk", -25, -25,
      "Домен уже находится в очереди Радара"));
  }
  if (input.latestEvidence?.status === "blocked" || input.latestEvidence?.status === "unknown") {
    factors.push(factor("unverified-page", "Недостоверность проверки", "risk", -10, -10,
      "Автоматическая проверка ограничена или не завершилась"));
  }
  if (input.features.trafficEstimate?.confidence === "low") {
    factors.push(factor("traffic-confidence", "Низкая уверенность трафика", "risk", -5, -5,
      `Оценка ${input.features.trafficEstimate.provider} имеет низкий confidence`));
  }
  const automaticTotal = clamp(factors.reduce((sum, item) => sum + item.value, 0), 0, 100);
  const manualAdjustment = input.manualAdjustment ?? 0;
  const total = clamp(automaticTotal + manualAdjustment, 0, 100);
  return {
    total,
    automaticTotal,
    manualAdjustment,
    manualAdjustmentComment: input.manualAdjustmentComment ?? null,
    priority: total >= 70 ? "high" : total >= 45 ? "medium" : "low",
    modelVersion: RADAR_SCORE_MODEL_VERSION,
    factors,
    calculatedAt: (input.calculatedAt ?? new Date()).toISOString(),
  };
}

export function emptyRadarFeatures(command: CreateRadarCandidateCommand): RadarCandidateFeatures {
  return {
    topic: command.topic?.trim() || null,
    language: command.language?.trim() || null,
    geography: command.geography?.trim() || null,
    publicationFrequency: command.publicationFrequency ?? "unknown",
    contactsFound: command.contactsFound ?? false,
    cms: command.cms?.trim() || null,
    estimatedVideoPagesMin: command.estimatedVideoPagesMin ?? null,
    estimatedVideoPagesMax: command.estimatedVideoPagesMax ?? null,
    trafficEstimate: command.trafficEstimate ?? null,
  };
}

function parseTrafficEstimate(input: unknown): RadarTrafficEstimate {
  if (!isRecord(input)) throw validation("Оценка трафика должна быть объектом");
  const provider = requiredText(input.provider, "trafficEstimate.provider", 120);
  const measuredAt = optionalDate(input.measuredAt, "trafficEstimate.measuredAt");
  if (!measuredAt) throw validation("Укажите дату оценки трафика", {
    "trafficEstimate.measuredAt": "Ожидается дата ISO",
  });
  const minMonthlyVisits = optionalNonNegativeInteger(input.minMonthlyVisits, "trafficEstimate.minMonthlyVisits");
  const maxMonthlyVisits = optionalNonNegativeInteger(input.maxMonthlyVisits, "trafficEstimate.maxMonthlyVisits");
  if (minMonthlyVisits === undefined || maxMonthlyVisits === undefined || minMonthlyVisits > maxMonthlyVisits) {
    throw validation("Некорректный диапазон трафика", {
      "trafficEstimate.maxMonthlyVisits": "Укажите максимум не меньше минимума",
    });
  }
  const confidence = input.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    throw validation("Некорректный confidence оценки трафика", {
      "trafficEstimate.confidence": "Используйте high, medium или low",
    });
  }
  const minDailyVisits = optionalNonNegativeInteger(input.minDailyVisits, "trafficEstimate.minDailyVisits");
  const maxDailyVisits = optionalNonNegativeInteger(input.maxDailyVisits, "trafficEstimate.maxDailyVisits");
  if (
    (minDailyVisits === undefined) !== (maxDailyVisits === undefined) ||
    (minDailyVisits !== undefined && maxDailyVisits !== undefined && minDailyVisits > maxDailyVisits)
  ) {
    throw validation("Некорректный дневной диапазон трафика", {
      "trafficEstimate.maxDailyVisits": "Укажите оба значения, максимум не меньше минимума",
    });
  }
  const periodStart = optionalDate(input.periodStart, "trafficEstimate.periodStart");
  const periodEnd = optionalDate(input.periodEnd, "trafficEstimate.periodEnd");
  return {
    provider,
    measuredAt,
    minMonthlyVisits,
    maxMonthlyVisits,
    ...(minDailyVisits === undefined ? {} : { minDailyVisits }),
    ...(maxDailyVisits === undefined ? {} : { maxDailyVisits }),
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    confidence,
  };
}

function factor(
  code: string,
  label: string,
  group: RadarScoreFactor["group"],
  value: number,
  maxValue: number,
  explanation: string,
): RadarScoreFactor {
  return { code, label, group, value, maxValue, explanation };
}

function trafficPoints(estimate: RadarTrafficEstimate | null) {
  const reach = estimate?.maxMonthlyVisits ?? 0;
  if (reach >= 1_000_000) return 24;
  if (reach >= 250_000) return 18;
  if (reach >= 50_000) return 12;
  return reach > 0 ? 6 : 0;
}

function trafficExplanation(estimate: RadarTrafficEstimate | null) {
  if (!estimate) return "Оценка охвата отсутствует";
  return `${estimate.provider}: ${estimate.minMonthlyVisits.toLocaleString("ru-RU")}–${estimate.maxMonthlyVisits.toLocaleString("ru-RU")} визитов/мес., confidence ${estimate.confidence}`;
}

function geographyPoints(value: string | null) {
  if (!value) return 0;
  return /росси|рф|снг|russia|cis/i.test(value) ? 8 : 4;
}

function publicationPoints(value: RadarCandidateFeatures["publicationFrequency"]) {
  if (value === "daily") return 8;
  if (value === "weekly") return 5;
  if (value === "monthly") return 2;
  return 0;
}

function publicationExplanation(value: RadarCandidateFeatures["publicationFrequency"]) {
  const labels = { daily: "ежедневно", weekly: "еженедельно", monthly: "ежемесячно", unknown: "не определена" };
  return `Частота публикаций: ${labels[value]}`;
}

function videoVolumePoints(value: number | null) {
  if (value === null) return 0;
  if (value >= 100) return 15;
  if (value >= 20) return 10;
  return value > 0 ? 5 : 0;
}

function videoVolumeExplanation(min: number | null, max: number | null) {
  if (min === null && max === null) return "Объём страниц с видео не оценён";
  return `Оценочный диапазон: ${min ?? 0}–${max ?? min ?? 0}`;
}

function evidenceAccessPoints(evidence: RadarEvidence | null) {
  return evidence?.status === "found" || evidence?.status === "not_found" ? 3 : 0;
}

function evidenceExplanation(evidence: RadarEvidence | null) {
  if (!evidence) return "Страница ещё не проверена";
  if (evidence.status === "blocked") return "Проверка ограничена robots.txt или сайтом";
  if (evidence.status === "unknown") return "Результат проверки неизвестен";
  return `Страница доступна, HTTP ${evidence.httpStatus ?? "—"}`;
}

function positiveInteger(value: unknown, field: string) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw validation("Некорректная версия", { [field]: "Ожидается положительное целое число" });
  }
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw validation("Некорректное числовое значение", { [field]: "Ожидается целое число не меньше нуля" });
  }
  return Number(value);
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw validation("Заполните обязательные поля", { [field]: "Обязательное поле" });
  }
  if (value.trim().length > maxLength) {
    throw validation("Значение слишком длинное", { [field]: `Максимум ${maxLength} символов` });
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw validation("Ожидается строка", { [field]: "Ожидается строка" });
  if (value.trim().length > maxLength) {
    throw validation("Значение слишком длинное", { [field]: `Максимум ${maxLength} символов` });
  }
  return value.trim() || undefined;
}

function optionalDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw validation("Некорректная дата", { [field]: "Ожидается дата ISO" });
  }
  return new Date(value).toISOString();
}

function validation(message: string, fieldErrors: Record<string, string> = {}) {
  return new DomainRuleError("RADAR_VALIDATION_FAILED", message, fieldErrors);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
