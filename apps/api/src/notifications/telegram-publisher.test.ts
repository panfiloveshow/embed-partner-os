import { describe, expect, it } from "vitest";
import type { OutboxEnvelope } from "../outbox/outbox-relay.service.js";
import {
  TelegramOutboxPublisher,
  formatDigestEnvelopeText,
  formatSlaEnvelopeText,
} from "./telegram-publisher.js";

const SECRET_SAFE_TOKEN = "123:abc-test-token";
const CHAT_ID = "-100200300";

function envelope(overrides: Partial<OutboxEnvelope> = {}): OutboxEnvelope {
  return {
    id: "evt-1",
    eventType: "opportunity.sla.warning",
    aggregateType: "Opportunity",
    aggregateId: "opp-1",
    aggregateVersion: 3,
    schemaVersion: 1,
    payload: {},
    occurredAt: new Date("2026-08-25T10:00:00Z"),
    attempts: 0,
    ...overrides,
  };
}

function stubFetcher(status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response("{}", { status });
  };
  return { calls, fetcher };
}

describe("TelegramOutboxPublisher", () => {
  it("отправляет отформатированный текст в чат через Bot API", async () => {
    const { calls, fetcher } = stubFetcher();
    const publisher = new TelegramOutboxPublisher(
      { botToken: SECRET_SAFE_TOKEN, chatId: CHAT_ID },
      () => "Привет, руководитель!",
      fetcher,
    );
    await publisher.publish(envelope());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${SECRET_SAFE_TOKEN}/sendMessage`);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.text).toContain("Привет");
  });

  it("неуспешный ответ API приводит к ошибке (ретрай релея)", async () => {
    const { fetcher } = stubFetcher(500);
    const publisher = new TelegramOutboxPublisher(
      { botToken: SECRET_SAFE_TOKEN, chatId: CHAT_ID },
      () => "текст",
      fetcher,
    );
    await expect(publisher.publish(envelope())).rejects.toThrow(/HTTP 500/);
  });

  it("пустой текст не отправляет запрос", async () => {
    const { calls, fetcher } = stubFetcher();
    const publisher = new TelegramOutboxPublisher(
      { botToken: SECRET_SAFE_TOKEN, chatId: CHAT_ID },
      () => "   ",
      fetcher,
    );
    await publisher.publish(envelope());
    expect(calls).toHaveLength(0);
  });

  it("пустой токен отклоняется на этапе конструирования", () => {
    expect(
      () =>
        new TelegramOutboxPublisher(
          { botToken: "  ", chatId: CHAT_ID },
          () => "x",
          async () => new Response("{}", { status: 200 }),
        ),
    ).toThrow();
  });
});

describe("форматирование текста событий", () => {
  it("SLA-событие содержит организацию, стадию и ссылку", () => {
    const text = formatSlaEnvelopeText(
      envelope({
        payload: {
          subject: "Зависла сделка",
          opportunityUrl: "https://app.example.ru/opportunities/opp-1",
          opportunity: {
            organizationName: "ООО Ромашка",
            ownerName: "Анна Соколова",
            stageLabel: "Переговоры",
          },
          sla: { thresholdDays: 5, violationAgeDays: 7 },
        },
      }),
    );
    expect(text).toContain("Зависла сделка");
    expect(text).toContain("ООО Ромашка");
    expect(text).toContain("Переговоры");
    expect(text).toContain("https://app.example.ru/opportunities/opp-1");
  });

  it("дайджест содержит команду, период и число исключений", () => {
    const text = formatDigestEnvelopeText(
      envelope({
        eventType: "report.weekly.published",
        payload: {
          subject: "Недельный отчёт",
          team: { id: "t1", name: "Команда внедрения" },
          period: { start: "2026-08-17", end: "2026-08-23" },
          revision: 2,
          exceptionCount: 4,
          reportUrl: "https://app.example.ru/reports/weekly",
        },
      }),
    );
    expect(text).toContain("Недельный отчёт");
    expect(text).toContain("Команда внедрения");
    expect(text).toContain("2026-08-17 — 2026-08-23");
    expect(text).toContain("Исключений: 4");
  });
});
