import { describe, expect, it } from "vitest";
import { HttpOutboxPublisher } from "./http-publisher.js";
import type { OutboxEnvelope } from "./outbox-relay.service.js";

const SECRET = "unit-test-secret-0123456789abcdef";

function envelope(): OutboxEnvelope {
  return {
    id: "evt-42",
    eventType: "report.weekly.published",
    aggregateType: "ReportSnapshot",
    aggregateId: "snap-1",
    aggregateVersion: 1,
    schemaVersion: 1,
    payload: { hello: "world" },
    occurredAt: new Date("2026-08-25T12:00:00Z"),
    attempts: 0,
  };
}

describe("HttpOutboxPublisher", () => {
  it("публикует конверт с подписью и Idempotency-Key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    };
    const publisher = new HttpOutboxPublisher(
      { url: "https://bus.example.invalid/events", secret: SECRET },
      fetcher,
    );
    await publisher.publish(envelope());

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("evt-42");
    expect(headers.get("x-embed-signature")?.startsWith("sha256=")).toBe(true);

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.eventType).toBe("report.weekly.published");
    expect(body.payload).toEqual({ hello: "world" });
  });

  it("неуспешный ответ приёмника приводит к ошибке", async () => {
    const fetcher = async () => new Response("{}", { status: 503 });
    const publisher = new HttpOutboxPublisher(
      { url: "https://bus.example.invalid/events", secret: SECRET },
      fetcher,
    );
    await expect(publisher.publish(envelope())).rejects.toThrow(/HTTP 503/);
  });

  it("неподдерживаемая схема отклоняется при конструировании", () => {
    expect(
      () =>
        new HttpOutboxPublisher(
          { url: "ftp://bus.example.invalid", secret: SECRET },
          async () => new Response("{}", { status: 200 }),
        ),
    ).toThrow(/OUTBOX_PUBLISH_URL/);
  });
});
