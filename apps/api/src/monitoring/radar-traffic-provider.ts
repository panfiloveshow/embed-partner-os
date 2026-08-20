import type { RadarTrafficEstimate } from "@embed-os/contracts";
import { SafeHttpClient, type SafeHttpResponse } from "./safe-http-client.js";

export interface RadarTrafficProvider {
  estimate(host: string, measuredAt: Date): Promise<RadarTrafficEstimate | null>;
}

export interface TrafficHttpReader {
  get(url: string): Promise<SafeHttpResponse>;
}

export class SimilarwebTrafficProvider implements RadarTrafficProvider {
  constructor(
    private readonly apiKey: string,
    private readonly http: TrafficHttpReader = new SafeHttpClient(),
  ) {}

  async estimate(host: string, measuredAt: Date): Promise<RadarTrafficEstimate | null> {
    if (!this.apiKey.trim()) return null;
    const endpoint = new URL(
      `https://api.similarweb.com/v1/website/${encodeURIComponent(host)}/total-traffic-and-engagement/visits`,
    );
    endpoint.searchParams.set("api_key", this.apiKey);
    endpoint.searchParams.set("country", "world");
    endpoint.searchParams.set("granularity", "daily");
    endpoint.searchParams.set("main_domain_only", "true");
    endpoint.searchParams.set("format", "json");

    const response = await this.http.get(endpoint.toString());
    if (response.status < 200 || response.status >= 300) return null;
    const observations = parseDailyVisits(response.body.toString("utf8"));
    if (observations.length === 0) return null;
    const values = observations.map(({ visits }) => visits);
    const averageDaily = values.reduce((sum, value) => sum + value, 0) / values.length;
    const centralMonthly = averageDaily * 30;
    return {
      provider: "Similarweb",
      measuredAt: measuredAt.toISOString(),
      minMonthlyVisits: Math.max(0, Math.floor(centralMonthly * 0.9)),
      maxMonthlyVisits: Math.ceil(centralMonthly * 1.1),
      minDailyVisits: Math.floor(Math.min(...values)),
      maxDailyVisits: Math.ceil(Math.max(...values)),
      periodStart: observations[0]?.date,
      periodEnd: observations.at(-1)?.date,
      confidence: "medium",
    };
  }
}

export function trafficProviderFromEnvironment(): RadarTrafficProvider | null {
  const apiKey = process.env.SIMILARWEB_API_KEY?.trim();
  return apiKey ? new SimilarwebTrafficProvider(apiKey) : null;
}

function parseDailyVisits(body: string) {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return [];
  }
  const records = findVisitsArray(value);
  return records
    .flatMap((item) => {
      if (!isRecord(item) || typeof item.date !== "string") return [];
      const rawVisits =
        typeof item.visits === "number"
          ? item.visits
          : typeof item.value === "number"
            ? item.value
            : null;
      if (rawVisits === null || !Number.isFinite(rawVisits) || rawVisits < 0) return [];
      return [{ date: item.date.slice(0, 10), visits: rawVisits }];
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function findVisitsArray(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.visits)) return value.visits;
  if (Array.isArray(value.data)) return value.data;
  if (isRecord(value.data) && Array.isArray(value.data.visits)) return value.data.visits;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
