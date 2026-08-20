import type { OutboxEnvelope, OutboxPublisher } from "../outbox/outbox-relay.service.js";
import { signedWebhookHeaders } from "../outbox/webhook-signature.js";
import type { ReportDigestItem } from "./report-digest.js";

export interface ReportDigestPublisherConfig {
  webhookUrl: string;
  publicAppUrl: string;
  recipients: string[];
  webhookSecret: string;
  timeoutMs?: number;
}

export interface ReportDigestMessage {
  type: "report.weekly.digest";
  schemaVersion: 1;
  messageId: string;
  recipients: string[];
  subject: string;
  reportUrl: string;
  team: { id: string; name: string };
  period: { start: string; end: string };
  revision: number;
  exceptionCount: number;
  items: ReportDigestItem[];
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ReportDigestWebhookPublisher implements OutboxPublisher {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ReportDigestPublisherConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.webhookUrl = parseHttpUrl(config.webhookUrl, "REPORT_DIGEST_WEBHOOK_URL").toString();
    parseHttpUrl(config.publicAppUrl, "PUBLIC_APP_URL");
    if (config.recipients.length === 0) {
      throw new Error("REPORT_DIGEST_RECIPIENTS must contain at least one recipient");
    }
    this.timeoutMs = normalizeTimeout(config.timeoutMs ?? 10_000);
  }

  async publish(event: OutboxEnvelope): Promise<void> {
    const message = buildReportDigestMessage(event, this.config);
    const body = JSON.stringify(message);
    const response = await this.fetcher(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...signedWebhookHeaders(event.id, body, this.config.webhookSecret),
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Report digest gateway returned HTTP ${response.status}`);
    }
  }
}

export function buildReportDigestMessage(
  event: OutboxEnvelope,
  config: Pick<ReportDigestPublisherConfig, "publicAppUrl" | "recipients">,
): ReportDigestMessage {
  if (event.eventType !== "report.weekly.published") {
    throw new TypeError(`Unsupported digest event type: ${event.eventType}`);
  }
  const payload = event.payload;
  const periodStart = requiredString(payload.periodStart, "periodStart");
  const periodEnd = requiredString(payload.periodEnd, "periodEnd");
  const reportPath = requiredString(payload.reportPath, "reportPath");
  return {
    type: "report.weekly.digest",
    schemaVersion: 1,
    messageId: event.id,
    recipients: normalizedRecipients(config.recipients),
    subject: `Недельный отчёт Embed Partner OS · ${formatPeriod(periodStart, periodEnd)}`,
    reportUrl: new URL(reportPath, parseHttpUrl(config.publicAppUrl, "PUBLIC_APP_URL")).toString(),
    team: {
      id: requiredString(payload.teamId, "teamId"),
      name: requiredString(payload.teamName, "teamName"),
    },
    period: { start: periodStart, end: periodEnd },
    revision: requiredNonNegativeInteger(payload.revision, "revision"),
    exceptionCount: requiredNonNegativeInteger(payload.exceptionCount, "exceptionCount"),
    items: digestItems(payload.digestItems),
  };
}

function digestItems(value: unknown): ReportDigestItem[] {
  if (!Array.isArray(value)) throw new TypeError("Digest event field digestItems must be an array");
  return value.slice(0, 7).map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`Digest item ${index} must be an object`);
    const kind = requiredString(item.kind, `digestItems[${index}].kind`);
    if (kind === "decision") {
      return {
        kind,
        title: requiredString(item.title, `digestItems[${index}].title`),
        owner: requiredString(item.owner, `digestItems[${index}].owner`),
        dueAt: requiredString(item.dueAt, `digestItems[${index}].dueAt`),
        affectedCount: requiredNonNegativeInteger(
          item.affectedCount,
          `digestItems[${index}].affectedCount`,
        ),
      };
    }
    if (kind === "risk") {
      const severity = requiredString(item.severity, `digestItems[${index}].severity`);
      if (severity !== "high" && severity !== "medium") {
        throw new TypeError(`Digest item ${index} has unsupported severity`);
      }
      return {
        kind,
        title: requiredString(item.title, `digestItems[${index}].title`),
        owner: requiredString(item.owner, `digestItems[${index}].owner`),
        severity,
        ageDays: requiredNonNegativeInteger(item.ageDays, `digestItems[${index}].ageDays`),
      };
    }
    throw new TypeError(`Digest item ${index} has unsupported kind`);
  });
}

function formatPeriod(start: string, end: string): string {
  const startParts = moscowDateParts(start);
  const endParts = moscowDateParts(end);
  if (startParts.month === endParts.month && startParts.year === endParts.year) {
    return `${startParts.day}–${endParts.day} ${endParts.month} ${endParts.year}`;
  }
  return `${startParts.day} ${startParts.month} – ${endParts.day} ${endParts.month} ${endParts.year}`;
}

function moscowDateParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Digest period must contain ISO dates");
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { day: values.day, month: values.month, year: values.year };
}

function parseHttpUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`${name} must be an absolute HTTP(S) URL without credentials`);
  }
  return url;
}

function normalizedRecipients(values: string[]): string[] {
  const recipients = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (recipients.length === 0) throw new Error("Digest recipients cannot be empty");
  return recipients;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Digest event field ${field} must be a non-empty string`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`Digest event field ${field} must be a non-negative integer`);
  }
  return value as number;
}

function normalizeTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new RangeError("Digest timeout must be between 100 and 60000 ms");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
