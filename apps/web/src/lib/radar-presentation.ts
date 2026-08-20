import type { RadarCandidate, RadarRejectReasonCode } from "@embed-os/contracts";

/** Russian labels for structured rejection reasons (Partner Score feedback). */
export const rejectReasonLabels: Record<RadarRejectReasonCode, string> = {
  no_video_editorial: "Нет видеоредакции",
  competitor_exclusive: "Эксклюзив у конкурента",
  dead_site: "Мёртвый сайт",
  low_traffic: "Низкий трафик",
  irrelevant_topic: "Нерелевантная тематика",
  other: "Другое",
};

export function rejectReasonLabel(code: RadarRejectReasonCode | null): string | null {
  return code ? (rejectReasonLabels[code] ?? code) : null;
}

export type RadarMessageTone = "error" | "success" | "warning";
export type RadarInspectionTone = "confirmed" | "neutral" | "warning";

type RadarEvidence = RadarCandidate["evidence"][number];

export interface RadarInspectionPresentation {
  statusLabel: string;
  tone: RadarInspectionTone;
  noticeTone: RadarMessageTone;
  notice: string;
  detail: string;
}

export function inspectionPresentation(evidence: RadarEvidence): RadarInspectionPresentation {
  const competitors = (evidence.detectedPlayers ?? [])
    .filter(({ competitor }) => competitor)
    .map(({ label }) => label);

  if (evidence.status === "found") {
    const player = evidence.playerType ?? "video";
    return {
      statusLabel: "Плеер найден",
      tone: "confirmed",
      noticeTone: "success",
      notice:
        competitors.length > 0
          ? `Сайт уже встраивает ${competitors.join(", ")} — сценарий миграции на RUTUBE-плеер.`
          : `Плеер ${player} обнаружен.`,
      detail:
        competitors.length > 0
          ? `Подтверждён сторонний видеохостинг: ${competitors.join(", ")}`
          : "Плеер подтверждён автоматической проверкой",
    };
  }

  if (evidence.status === "not_found") {
    // Defensive branch: a detection recorded together with "not_found" must
    // still read as a positive video signal, not as an alarming failure.
    if (evidence.detectedPlayers?.length) {
      const labels = [...new Set(evidence.detectedPlayers.map(({ label }) => label))];
      return {
        statusLabel: "Видео найдено",
        tone: "confirmed",
        noticeTone: "success",
        notice: `Найден видеоплеер: ${labels.join(", ")}.`,
        detail: `Сигнатуры плееров подтверждены: ${labels.join(", ")}`,
      };
    }
    return {
      statusLabel: "Плеер не найден",
      tone: "neutral",
      noticeTone: "warning",
      notice: "Проверка завершена: сигнатуры видеоплееров на сайте не найдены.",
      detail: "Страница доступна, но сигнатуры видеоплееров не найдены",
    };
  }

  if (evidence.status === "blocked") {
    return {
      statusLabel: "Проверка ограничена",
      tone: "warning",
      noticeTone: "warning",
      notice: `Проверка ограничена: ${inspectionErrorLabel(evidence.errorCode)}.`,
      detail: inspectionErrorLabel(evidence.errorCode),
    };
  }

  return {
    statusLabel: "Не проверен",
    tone: "warning",
    noticeTone: "warning",
    notice: `Проверка не выполнена: ${inspectionErrorLabel(evidence.errorCode)}. Повторите позже.`,
    detail: inspectionErrorLabel(evidence.errorCode),
  };
}

export function inspectionErrorLabel(errorCode: string | null): string {
  const labels: Record<string, string> = {
    NETWORK_ERROR: "нет сетевого доступа к странице",
    NETWORK_TIMEOUT: "страница не ответила вовремя",
    NETWORK_TARGET_BLOCKED: "адрес заблокирован политикой безопасности",
    ROBOTS_ACCESS_DENIED: "robots.txt недоступен для проверки",
    ROBOTS_DISALLOWED: "проверка запрещена robots.txt",
    PAGE_HTTP_BLOCKED: "сайт отклонил автоматический запрос",
    PAGE_HTTP_ERROR: "сайт вернул ошибку HTTP",
    PAGE_CONTENT_TYPE_UNSUPPORTED: "формат ответа не поддерживается",
    RESPONSE_TOO_LARGE: "ответ страницы превышает допустимый размер",
    VIDEO_PATTERN_NOT_FOUND: "поддерживаемые паттерны видеоплеера не найдены",
  };
  return errorCode
    ? (labels[errorCode] ?? `техническая причина ${errorCode}`)
    : "причина не определена";
}
