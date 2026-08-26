import type { OutboxEnvelope, OutboxPublisher } from "../outbox/outbox-relay.service.js";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TelegramPublisherConfig {
  botToken: string;
  chatId: string;
  timeoutMs?: number;
}

const TELEGRAM_TEXT_LIMIT = 4_000;

/**
 * Публикует outbox-события в Telegram-чат через Bot API. Формат текста
 * передаётся колбэком format — издатель не знает доменных деталей событий.
 * Используется воркерами при *_CHANNEL=telegram вместо webhook-шлюза.
 */
export class TelegramOutboxPublisher implements OutboxPublisher {
  private readonly sendMessageUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: TelegramPublisherConfig,
    private readonly format: (event: OutboxEnvelope) => string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    if (!config.botToken.trim()) throw new Error("TELEGRAM_BOT_TOKEN is required");
    if (!config.chatId.trim()) throw new Error("Telegram chat id is required");
    this.sendMessageUrl = `https://api.telegram.org/bot${config.botToken.trim()}/sendMessage`;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async publish(event: OutboxEnvelope): Promise<void> {
    const text = clip(this.format(event));
    if (!text.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.sendMessageUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          disable_web_page_preview: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function clip(text: string): string {
  return text.length > TELEGRAM_TEXT_LIMIT
    ? `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`
    : text;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Читаемый текст для SLA-событий (opportunity.sla.warning / escalated). */
export function formatSlaEnvelopeText(event: OutboxEnvelope): string {
  const p = event.payload as Record<string, unknown>;
  const opportunity = (p.opportunity ?? {}) as Record<string, unknown>;
  const sla = (p.sla ?? {}) as Record<string, unknown>;
  const lines = [
    `⏰ ${str(p.subject) || str(p.type) || event.eventType}`,
    "",
    `Организация: ${str(opportunity.organizationName) || "—"}`,
    `Владелец: ${str(opportunity.ownerName) || "—"}`,
    `Стадия: ${str(opportunity.stageLabel) || "—"}`,
    `Порог SLA: ${sla.thresholdDays ?? "—"} дн., зависание: ${sla.violationAgeDays ?? "—"} дн.`,
  ];
  const url = str(p.opportunityUrl);
  if (url) lines.push("", url);
  return lines.join("\n");
}

/** Читаемый текст недельного дайджеста руководителя. */
export function formatDigestEnvelopeText(event: OutboxEnvelope): string {
  const p = event.payload as Record<string, unknown>;
  const team = (p.team ?? {}) as Record<string, unknown>;
  const period = (p.period ?? {}) as Record<string, unknown>;
  const lines = [
    `📊 ${str(p.subject) || "Недельный отчёт"}`,
    "",
    `Команда: ${str(team.name) || "—"}`,
    `Период: ${str(period.start)} — ${str(period.end)}`,
    `Ревизия: ${p.revision ?? "—"} · Исключений: ${p.exceptionCount ?? 0}`,
  ];
  const url = str(p.reportUrl);
  if (url) lines.push("", url);
  return lines.join("\n");
}
