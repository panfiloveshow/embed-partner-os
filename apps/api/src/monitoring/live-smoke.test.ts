import { describe, expect, it } from "vitest";
import { TrancoTrafficProvider } from "./tranco-traffic-provider.js";
import { RadarPageInspector } from "./radar-page-inspector.js";

/**
 * Живой smoke внешних источников Радара. По умолчанию ПРОПУСКАЕТСЯ —
 * запускается только с RUN_LIVE_SMOKE=1 (еженедельный cron в CI,
 * workflow "Live smoke"). Ловит деградацию внешнего мира (как баг
 * сменившегося API Tranco) без ожидания пуша.
 */
const enabled = process.env.RUN_LIVE_SMOKE === "1";

describe.skipIf(!enabled)("live smoke: внешние источники Радара живы", () => {
  it("Tranco API отвечает рангом для известного домена", async () => {
    const provider = new TrancoTrafficProvider({ enabled: true, minRequestIntervalMs: 0 });
    const estimate = await provider.estimate("vc.ru", new Date());
    expect(estimate).not.toBeNull();
    expect(estimate?.minMonthlyVisits).toBeGreaterThan(0);
    expect(estimate?.maxDailyVisits).toBeGreaterThan(0);
  }, 30_000);

  it("полная инспекция vc.ru собирает тему и трафик", async () => {
    const provider = new TrancoTrafficProvider({ enabled: true, minRequestIntervalMs: 0 });
    const inspector = new RadarPageInspector(undefined, undefined, provider, null);
    const observation = await inspector.inspect("https://vc.ru");
    // ok = плеер подтверждён; found = страница исследована без плеера — оба исхода
    // означают, что цепочка «сайт → исследование» работает.
    expect(["ok", "found"]).toContain(observation.status);
    expect(observation.featureExtraction?.features.topic).not.toBeNull();
    expect(observation.featureExtraction?.features.trafficEstimate).not.toBeNull();
  }, 180_000);
});
