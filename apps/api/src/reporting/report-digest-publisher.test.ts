import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { OutboxEnvelope } from "../outbox/outbox-relay.service.js";
import {
  ReportDigestWebhookPublisher,
  buildReportDigestMessage,
} from "./report-digest-publisher.js";

const EVENT = reportEvent();

describe("report digest publisher", () => {
  it("builds a compact digest with an absolute report URL", () => {
    expect(
      buildReportDigestMessage(EVENT, {
        publicAppUrl: "https://embed-os.example.test/base/",
        recipients: ["lead@example.test"],
      }),
    ).toEqual({
      type: "report.weekly.digest",
      schemaVersion: 1,
      messageId: "event-report-1",
      recipients: ["lead@example.test"],
      subject: "Недельный отчёт Embed Partner OS · 10–16 августа 2026",
      reportUrl: "https://embed-os.example.test/reports/weekly/snapshots/latest",
      team: { id: "team-1", name: "Команда внедрения" },
      period: {
        start: "2026-08-09T21:00:00.000Z",
        end: "2026-08-16T20:59:59.999Z",
      },
      revision: 2,
      exceptionCount: 10,
      items: [
        {
          kind: "decision",
          title: "Какие просрочки нужно эскалировать?",
          owner: "Руководитель команды",
          dueAt: "2026-08-18T07:00:00.000Z",
          affectedCount: 10,
        },
      ],
    });
  });

  it("sends the outbox id as the delivery idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const publisher = new ReportDigestWebhookPublisher(
      {
        webhookUrl: "https://notify.example.test/v1/messages",
        publicAppUrl: "https://embed-os.example.test",
        recipients: ["lead@example.test"],
        webhookSecret: "report-webhook-secret-with-at-least-32-characters",
      },
      fetcher,
    );

    await publisher.publish(EVENT);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://notify.example.test/v1/messages");
    expect(request).toEqual(expect.objectContaining({ method: "POST" }));
    const headers = new Headers(request?.headers);
    const body = String(request?.body);
    const timestamp = headers.get("X-Embed-Timestamp");
    expect(headers.get("Idempotency-Key")).toBe("event-report-1");
    expect(headers.get("X-Embed-Signature")).toBe(`sha256=${createHmac(
      "sha256",
      "report-webhook-secret-with-at-least-32-characters",
    ).update(`${timestamp}.event-report-1.${body}`).digest("hex")}`);
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({ messageId: "event-report-1" }),
    );
  });

  it("fails the relay attempt when the notification gateway rejects delivery", async () => {
    const publisher = new ReportDigestWebhookPublisher(
      {
        webhookUrl: "https://notify.example.test/v1/messages",
        publicAppUrl: "https://embed-os.example.test",
        recipients: ["lead@example.test"],
        webhookSecret: "report-webhook-secret-with-at-least-32-characters",
      },
      async () => new Response("temporary failure", { status: 503 }),
    );

    await expect(publisher.publish(EVENT)).rejects.toThrow(
      "Report digest gateway returned HTTP 503",
    );
  });
});

function reportEvent(): OutboxEnvelope {
  return {
    id: "event-report-1",
    eventType: "report.weekly.published",
    aggregateType: "ReportSnapshot",
    aggregateId: "snapshot-1",
    aggregateVersion: 2,
    schemaVersion: 1,
    occurredAt: new Date("2026-08-17T07:00:01.000Z"),
    attempts: 1,
    payload: {
      snapshotId: "snapshot-1",
      teamId: "team-1",
      teamName: "Команда внедрения",
      periodStart: "2026-08-09T21:00:00.000Z",
      periodEnd: "2026-08-16T20:59:59.999Z",
      revision: 2,
      reportPath: "/reports/weekly/snapshots/latest",
      exceptionCount: 10,
      digestItems: [
        {
          kind: "decision",
          title: "Какие просрочки нужно эскалировать?",
          owner: "Руководитель команды",
          dueAt: "2026-08-18T07:00:00.000Z",
          affectedCount: 10,
        },
      ],
    },
  };
}
