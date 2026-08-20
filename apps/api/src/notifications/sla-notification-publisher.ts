import type { OutboxEnvelope, OutboxPublisher } from "../outbox/outbox-relay.service.js";
import { signedWebhookHeaders } from "../outbox/webhook-signature.js";

export const SLA_NOTIFICATION_EVENTS = ["opportunity.stale", "opportunity.sla_escalated"] as const;

export interface SlaNotificationPublisherConfig {
  webhookUrl: string;
  publicAppUrl: string;
  escalationRecipients: string[];
  webhookSecret: string;
  timeoutMs?: number;
}

export interface SlaNotificationMessage {
  type: "opportunity.sla.warning" | "opportunity.sla.escalated";
  schemaVersion: 1;
  messageId: string;
  recipients: string[];
  subject: string;
  opportunityUrl: string;
  opportunity: {
    id: string;
    organizationId: string;
    organizationName: string;
    ownerName: string;
    stageCode: string;
    stageLabel: string;
  };
  sla: {
    thresholdDays: number;
    violationAgeDays: number;
    incidentId: string;
    taskId: string | null;
    detectedAt: string;
  };
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class SlaNotificationWebhookPublisher implements OutboxPublisher {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: SlaNotificationPublisherConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.webhookUrl = httpUrl(config.webhookUrl, "SLA_NOTIFICATION_WEBHOOK_URL").toString();
    httpUrl(config.publicAppUrl, "PUBLIC_APP_URL");
    this.timeoutMs = timeout(config.timeoutMs ?? 10_000);
  }

  async publish(event: OutboxEnvelope): Promise<void> {
    const message = buildSlaNotificationMessage(event, this.config);
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
      throw new Error(`SLA notification gateway returned HTTP ${response.status}`);
    }
  }
}

export function buildSlaNotificationMessage(
  event: OutboxEnvelope,
  config: Pick<SlaNotificationPublisherConfig, "publicAppUrl" | "escalationRecipients">,
): SlaNotificationMessage {
  if (!SLA_NOTIFICATION_EVENTS.some((eventType) => eventType === event.eventType)) {
    throw new TypeError(`Unsupported SLA notification event type: ${event.eventType}`);
  }
  const payload = event.payload;
  const escalated = event.eventType === "opportunity.sla_escalated";
  const ownerEmail = requiredString(payload.ownerEmail, "ownerEmail");
  const organizationName = requiredString(payload.organizationName, "organizationName");
  const recipients = escalated
    ? normalizedRecipients(config.escalationRecipients, "SLA_ESCALATION_RECIPIENTS")
    : [ownerEmail];
  return {
    type: escalated ? "opportunity.sla.escalated" : "opportunity.sla.warning",
    schemaVersion: 1,
    messageId: event.id,
    recipients,
    subject: escalated
      ? `Эскалация SLA · ${organizationName}`
      : `Требуется реакция по SLA · ${organizationName}`,
    opportunityUrl: new URL(
      requiredString(payload.opportunityPath, "opportunityPath"),
      httpUrl(config.publicAppUrl, "PUBLIC_APP_URL"),
    ).toString(),
    opportunity: {
      id: requiredString(payload.opportunityId, "opportunityId"),
      organizationId: requiredString(payload.organizationId, "organizationId"),
      organizationName,
      ownerName: requiredString(payload.ownerName, "ownerName"),
      stageCode: requiredString(payload.stageCode, "stageCode"),
      stageLabel: requiredString(payload.stageLabel, "stageLabel"),
    },
    sla: {
      thresholdDays: nonNegativeInteger(payload.thresholdDays, "thresholdDays"),
      violationAgeDays: nonNegativeInteger(payload.violationAgeDays, "violationAgeDays"),
      incidentId: requiredString(payload.incidentId, "incidentId"),
      taskId: optionalString(payload.taskId, "taskId"),
      detectedAt: requiredString(payload.detectedAt, "detectedAt"),
    },
  };
}

function httpUrl(value: string, name: string) {
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

function normalizedRecipients(values: string[], name: string) {
  const recipients = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (recipients.length === 0) throw new Error(`${name} must contain at least one recipient`);
  return recipients;
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`SLA event field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string) {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function nonNegativeInteger(value: unknown, field: string) {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`SLA event field ${field} must be a non-negative integer`);
  }
  return value as number;
}

function timeout(value: number) {
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new RangeError("SLA notification timeout must be between 100 and 60000 ms");
  }
  return value;
}
