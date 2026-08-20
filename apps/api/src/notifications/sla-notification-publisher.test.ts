import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { OutboxEnvelope } from "../outbox/outbox-relay.service.js";
import {
  SlaNotificationWebhookPublisher,
  buildSlaNotificationMessage,
} from "./sla-notification-publisher.js";

describe("SLA notification publisher", () => {
  it("routes the first warning to the opportunity owner", () => {
    expect(buildSlaNotificationMessage(event("opportunity.stale"), {
      publicAppUrl: "https://embed-os.example.test",
      escalationRecipients: ["lead@example.test"],
    })).toMatchObject({
      type: "opportunity.sla.warning",
      recipients: ["anna@example.test"],
      subject: "Требуется реакция по SLA · Медиа",
      opportunityUrl: "https://embed-os.example.test/?opportunity=opportunity-1",
    });
  });

  it("routes a prolonged violation to the configured team lead once", () => {
    expect(buildSlaNotificationMessage(event("opportunity.sla_escalated"), {
      publicAppUrl: "https://embed-os.example.test",
      escalationRecipients: ["lead@example.test", "lead@example.test"],
    })).toMatchObject({
      type: "opportunity.sla.escalated",
      recipients: ["lead@example.test"],
      subject: "Эскалация SLA · Медиа",
    });
  });

  it("uses the outbox id as the delivery idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const publisher = new SlaNotificationWebhookPublisher({
      webhookUrl: "https://notify.example.test/v1/messages",
      publicAppUrl: "https://embed-os.example.test",
      escalationRecipients: ["lead@example.test"],
      webhookSecret: "sla-webhook-secret-with-at-least-32-characters",
    }, fetcher);

    await publisher.publish(event("opportunity.stale"));

    const [, request] = fetcher.mock.calls[0] ?? [];
    const headers = new Headers(request?.headers);
    const body = String(request?.body);
    const timestamp = headers.get("X-Embed-Timestamp");
    expect(headers.get("Idempotency-Key")).toBe("event-sla-1");
    expect(headers.get("X-Embed-Message-Id")).toBe("event-sla-1");
    expect(headers.get("X-Embed-Signature")).toBe(`sha256=${createHmac(
      "sha256",
      "sla-webhook-secret-with-at-least-32-characters",
    ).update(`${timestamp}.event-sla-1.${body}`).digest("hex")}`);
  });
});

function event(eventType: string): OutboxEnvelope {
  return {
    id: "event-sla-1",
    eventType,
    aggregateType: "OpportunitySlaIncident",
    aggregateId: "incident-1",
    aggregateVersion: eventType === "opportunity.stale" ? 1 : 2,
    schemaVersion: 1,
    occurredAt: new Date("2026-08-20T09:00:00.000Z"),
    attempts: 1,
    payload: {
      incidentId: "incident-1",
      opportunityId: "opportunity-1",
      organizationId: "organization-1",
      organizationName: "Медиа",
      ownerId: "owner-1",
      ownerName: "Анна Соколова",
      ownerEmail: "anna@example.test",
      teamId: "team-1",
      teamName: "Команда внедрения",
      stageCode: "S4",
      stageLabel: "Диалог",
      thresholdDays: 5,
      violationAgeDays: 3,
      taskId: "task-1",
      detectedAt: "2026-08-20T09:00:00.000Z",
      opportunityPath: "/?opportunity=opportunity-1",
    },
  };
}
