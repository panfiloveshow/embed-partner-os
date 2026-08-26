import { describe, expect, it } from "vitest";
import {
  TrancoTrafficProvider,
  pickLatestRank,
  rankToMonthlyVisitsBand,
} from "./tranco-traffic-provider.js";
import type { TrafficHttpReader } from "./radar-traffic-provider.js";
import type { SafeHttpResponse } from "./safe-http-client.js";

function readerWith(responses: Array<SafeHttpResponse>): {
  reader: TrafficHttpReader;
  urls: string[];
} {
  const urls: string[] = [];
  let call = 0;
  return {
    urls,
    reader: {
      async get(url: string) {
        urls.push(url);
        const response = responses[Math.min(call, responses.length - 1)];
        call += 1;
        return response;
      },
    },
  };
}

function httpResponse(status: number, body: string): SafeHttpResponse {
  return {
    status,
    body: Buffer.from(body, "utf8"),
    url: new URL("https://tranco-list.eu/test"),
    headers: { "content-type": "application/json" },
  };
}

const RANKS_JSON = JSON.stringify({
  ranks: [
    { date: "2026-08-20", rank: 5100 },
    { date: "2026-08-25", rank: 45_000 },
    { date: "2026-08-18", rank: 4_900 },
  ],
  domain: "lenta.ru",
});

describe("rankToMonthlyVisitsBand", () => {
  it("широкие полосы порядка величины по рангу", () => {
    expect(rankToMonthlyVisitsBand(1)).toEqual({
      minMonthlyVisits: 100_000_000,
      maxMonthlyVisits: 1_000_000_000,
    });
    expect(rankToMonthlyVisitsBand(45_000)?.minMonthlyVisits).toBe(400_000);
    expect(rankToMonthlyVisitsBand(900_000)).toEqual({
      minMonthlyVisits: 30_000,
      maxMonthlyVisits: 80_000,
    });
    expect(rankToMonthlyVisitsBand(0)).toBeNull();
    expect(rankToMonthlyVisitsBand(Number.NaN)).toBeNull();
  });
});

describe("pickLatestRank", () => {
  it("берёт ранг самой свежей даты", () => {
    expect(pickLatestRank(RANKS_JSON)).toBe(45_000);
  });

  it("пустой список рангов -> null", () => {
    expect(pickLatestRank(JSON.stringify({ ranks: [], domain: "x.ru" }))).toBeNull();
  });

  it("битый JSON и мусорные записи -> null", () => {
    expect(pickLatestRank("не-json")).toBeNull();
    expect(
      pickLatestRank(JSON.stringify({ ranks: [{ date: "мусор", rank: 5 }, { date: "2026-08-01" }] })),
    ).toBeNull();
  });
});

describe("TrancoTrafficProvider", () => {
  const measuredAt = new Date("2026-08-25T10:00:00Z");
  const config = { enabled: true, minRequestIntervalMs: 0 };

  it("запрашивает ранг домена и возвращает помеченную оценку", async () => {
    const { reader, urls } = readerWith([httpResponse(200, RANKS_JSON)]);
    const provider = new TrancoTrafficProvider(config, reader);
    const estimate = await provider.estimate("www.Lenta.ru", measuredAt);

    expect(urls[0]).toContain("https://tranco-list.eu/api/ranks/domain/lenta.ru");
    expect(estimate?.provider).toContain("Tranco");
    // Ранг 45000 (свежайшая дата 2026-08-25) -> полоса 400k–3M.
    expect(estimate?.minMonthlyVisits).toBe(400_000);
    expect(estimate?.maxMonthlyVisits).toBe(3_000_000);
    expect(estimate?.measuredAt).toBe(measuredAt.toISOString());
  });

  it("кэширует ответ по домену: повторный вызов не делает HTTP-запросов", async () => {
    const { reader, urls } = readerWith([httpResponse(200, RANKS_JSON)]);
    const provider = new TrancoTrafficProvider(config, reader);
    await provider.estimate("vk.com", measuredAt);
    await provider.estimate("vk.com", measuredAt);
    expect(urls).toHaveLength(1);
  });

  it("разные домены -> разные запросы", async () => {
    const { reader, urls } = readerWith([
      httpResponse(200, RANKS_JSON),
      httpResponse(200, JSON.stringify({ ranks: [{ date: "2026-08-25", rank: 2 }] })),
    ]);
    const provider = new TrancoTrafficProvider(config, reader);
    const lenta = await provider.estimate("lenta.ru", measuredAt);
    const vk = await provider.estimate("vk.com", measuredAt);
    expect(urls).toHaveLength(2);
    expect(lenta?.minMonthlyVisits).toBe(400_000);
    expect(vk?.maxMonthlyVisits).toBe(1_000_000_000);
  });

  it("домен вне списка -> null, негативный ответ кэшируется", async () => {
    const { reader, urls } = readerWith([
      httpResponse(200, JSON.stringify({ ranks: [], domain: "неизвестный-blog.ru" })),
    ]);
    const provider = new TrancoTrafficProvider(config, reader);
    await expect(provider.estimate("неизвестный-blog.ru", measuredAt)).resolves.toBeNull();
    await expect(provider.estimate("неизвестный-blog.ru", measuredAt)).resolves.toBeNull();
    expect(urls).toHaveLength(1);
  });

  it("недоступность Tranco не ломает инспекцию -> null без кэширования сбоя", async () => {
    const { reader, urls } = readerWith([httpResponse(503, "unavailable")]);
    const provider = new TrancoTrafficProvider(config, reader);
    await expect(provider.estimate("lenta.ru", measuredAt)).resolves.toBeNull();
    // Сбой не кэшируется: следующая проверка пробует снова.
    await provider.estimate("lenta.ru", measuredAt);
    expect(urls.length).toBeGreaterThanOrEqual(2);
  });

  it("404 от API трактуется как «домена нет в списке»", async () => {
    const { reader } = readerWith([httpResponse(404, "Not Found")]);
    const provider = new TrancoTrafficProvider(config, reader);
    await expect(provider.estimate("example.org", measuredAt)).resolves.toBeNull();
  });
});
