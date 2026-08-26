import { describe, expect, it } from "vitest";
import {
  TrancoTrafficProvider,
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
    headers: { "content-type": "text/plain" },
  };
}

const LIST_ID_JSON = JSON.stringify({ list_id: "ABC123" });
const LIST_CSV = [
  "1,google.com",
  "2,youtube.com",
  "3,vk.com",
  "1200,lenta.ru",
  "45000,vc.ru",
].join("\n");

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

describe("TrancoTrafficProvider", () => {
  const measuredAt = new Date("2026-08-25T10:00:00Z");

  it("извлекает ранг домена и возвращает помеченную оценку", async () => {
    const { reader, urls } = readerWith([
      httpResponse(200, LIST_ID_JSON),
      httpResponse(200, LIST_CSV),
    ]);
    const provider = new TrancoTrafficProvider({ enabled: true }, reader);
    const estimate = await provider.estimate("www.Lenta.ru", measuredAt);

    expect(urls[0]).toContain("/api/lists/date/daily");
    expect(urls[1]).toContain("/api/lists/download/id/ABC123");
    expect(estimate?.provider).toContain("Tranco");
    expect(estimate?.minMonthlyVisits).toBe(3_000_000);
    expect(estimate?.maxMonthlyVisits).toBe(20_000_000);
    expect(estimate?.measuredAt).toBe(measuredAt.toISOString());
  });

  it("кэширует список: второй вызов не делает HTTP-запросов", async () => {
    const { reader, urls } = readerWith([
      httpResponse(200, LIST_ID_JSON),
      httpResponse(200, LIST_CSV),
    ]);
    const provider = new TrancoTrafficProvider({ enabled: true }, reader);
    await provider.estimate("vk.com", measuredAt);
    await provider.estimate("vc.ru", measuredAt);
    expect(urls).toHaveLength(2);
  });

  it("домен вне списка -> null (честное «нет данных»)", async () => {
    const { reader } = readerWith([
      httpResponse(200, LIST_ID_JSON),
      httpResponse(200, LIST_CSV),
    ]);
    const provider = new TrancoTrafficProvider({ enabled: true }, reader);
    await expect(provider.estimate("неизвестный-blog.ru", measuredAt)).resolves.toBeNull();
  });

  it("недоступность Tranco не ломает инспекцию -> null", async () => {
    const { reader } = readerWith([httpResponse(503, "unavailable")]);
    const provider = new TrancoTrafficProvider({ enabled: true }, reader);
    await expect(provider.estimate("lenta.ru", measuredAt)).resolves.toBeNull();
  });
});
