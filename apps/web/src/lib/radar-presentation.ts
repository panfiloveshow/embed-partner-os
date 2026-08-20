import type { RadarCandidate } from "@embed-os/contracts";

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
  if (evidence.status === "found") {
    const player = evidence.playerType ?? "video";
    return {
      statusLabel: "Плеер найден",
      tone: "confirmed",
      noticeTone: "success",
      notice: `Плеер ${player} обнаружен.`,
      detail: "Плеер подтверждён автоматической проверкой",
    };
  }

  if (evidence.status === "not_found") {
    return {
      statusLabel: "Плеер не найден",
      tone: "neutral",
      noticeTone: "warning",
      notice: "Проверка завершена: видеоплеер на странице не найден.",
      detail: "Страница доступна, но поддерживаемые паттерны видеоплеера не найдены",
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
