import { describe, expect, it } from "vitest";
import { SimilarwebTrafficProvider, type TrafficHttpReader } from "./radar-traffic-provider.js";

describe("SimilarwebTrafficProvider", () => {
  it("turns recent official daily visits into transparent daily and monthly ranges", async () => {
    let requestedUrl = "";
    const reader: TrafficHttpReader = {
      async get(url) {
        requestedUrl = url;
        return {
          url: new URL(url),
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ visits: [
            { date: "2026-07-01", visits: 1_000 },
            { date: "2026-07-02", visits: 1_200 },
            { date: "2026-07-03", visits: 800 },
            { date: "2026-07-04", visits: 1_100 },
          ] })),
        };
      },
    };
    const provider = new SimilarwebTrafficProvider("secret-key", reader);

    const estimate = await provider.estimate("media.example", new Date("2026-08-19T12:00:00.000Z"));

    expect(requestedUrl).toContain("granularity=daily");
    expect(requestedUrl).toContain("country=world");
    expect(estimate).toMatchObject({
      provider: "Similarweb",
      measuredAt: "2026-08-19T12:00:00.000Z",
      minDailyVisits: 800,
      maxDailyVisits: 1_200,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-04",
      confidence: "medium",
    });
    expect(estimate?.minMonthlyVisits).toBeLessThan(estimate?.maxMonthlyVisits ?? 0);
  });

  it("does not invent a traffic estimate when the provider has no usable observations", async () => {
    const provider = new SimilarwebTrafficProvider("secret-key", {
      async get(url) {
        return {
          url: new URL(url), status: 200, headers: { "content-type": "application/json" },
          body: Buffer.from('{"visits":[]}'),
        };
      },
    });

    await expect(provider.estimate("media.example", new Date())).resolves.toBeNull();
  });
});
