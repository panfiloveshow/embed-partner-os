import type { OutboxEnvelope, OutboxPublisher } from "./outbox-relay.service.js";
import { signedWebhookHeaders } from "./webhook-signature.js";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpOutboxPublisherConfig {
  /** HTTPS-эндпоинт приёмника событий (корпоративная шина, n8n, webhook-релей). */
  url: string;
  /** Секрет HMAC-подписи (тот же алгоритм, что у digest/SLA-webhooks). */
  secret: string;
  timeoutMs?: number;
}

/**
 * Транспорт публикации outbox-событий по HTTP: каждое событие уходит
 * отдельным POST c HMAC-подписью (X-Embed-Signature) и Idempotency-Key,
 * поэтому приёмник может безопасно ретраить и проверять подлинность.
 * Подключается воркером outbox-relay; брокер (RabbitMQ) остаётся
 * совместимым расширением через тот же интерфейс OutboxPublisher.
 */
export class HttpOutboxPublisher implements OutboxPublisher {
  private readonly targetUrl: URL;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: HttpOutboxPublisherConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.targetUrl = new URL(config.url);
    if (!["http:", "https:"].includes(this.targetUrl.protocol)) {
      throw new Error(`OUTBOX_PUBLISH_URL: неподдерживаемая схема ${this.targetUrl.protocol}`);
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async publish(event: OutboxEnvelope): Promise<void> {
    const body = JSON.stringify(event);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.targetUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...signedWebhookHeaders(event.id, body, this.config.secret),
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Outbox publish failed: HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
