import type { RadarTrafficEstimate } from "@embed-os/contracts";
import { SafeHttpClient } from "./safe-http-client.js";
// Тип-only импорт: цикла в рантайме не создаёт.
import type { TrafficHttpReader } from "./radar-traffic-provider.js";

/**
 * Бесплатный провайдер оценки трафика на основе открытого рейтинга Tranco
 * (tranco-list.eu) — агрегированного глобального рейтинга доменов по трафику.
 *
 * Что даёт честно: ФАКТИЧЕСКИЙ глобальный ранг домена (свежий дневной список)
 * и порядок величины месячных визитов широкой полосой. Это не панельные данные
 * уровня Similarweb — значение помечается провайдером "Tranco (ранг)", чтобы
 * менеджер понимал природу оценки. Домены вне топ-листа -> null («нет данных»).
 *
 * С апреля 2026 Tranco отдаёт ранги через эндпоинт
 * GET https://tranco-list.eu/api/ranks/domain/{domain}
 * (ответ: {"ranks":[{"date":"YYYY-mm-dd","rank":N}, …], "domain":"…"} —
 * дневные списки за последние ~30 дней; лимит 1 запрос/сек). Старый формат
 * «скачать весь список целиком» больше не поддерживается их API.
 *
 * Ответ по домену кэшируется в памяти процесса на RADAR_TRANKO_TTL_DAYS дней
 * (по умолчанию 7); негативный ответ («домена нет в списке») кэшируется так же,
 * чтобы повторные проверки не тратили лимит запросов.
 */

export interface TrancoProviderConfig {
  enabled: boolean;
  /** Сколько дней кэшировать ответ по домену (по умолчанию 7). */
  ttlDays?: number;
  /** Минимальный интервал между запросами к API (мс; лимит Tranco 1/сек). */
  minRequestIntervalMs?: number;
}

interface CachedRank {
  fetchedAt: number;
  /** null = домен вне списка (негативный ответ кэшируется наравне с рангом). */
  rank: number | null;
}

const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_100;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Порядок величины месячных визитов по глобальному рангу. Полосы намеренно
 * широкие (±порядок): источник — ранг агрегатора, а не счётчик визитов.
 * Опорные точки соответствуют общедоступным данным по головным доменам.
 */
export function rankToMonthlyVisitsBand(rank: number): {
  minMonthlyVisits: number;
  maxMonthlyVisits: number;
} | null {
  if (!Number.isFinite(rank) || rank < 1) return null;
  const bands: Array<readonly [number, number, number]> = [
    [100, 100_000_000, 1_000_000_000],
    [1_000, 20_000_000, 100_000_000],
    [10_000, 3_000_000, 20_000_000],
    [100_000, 400_000, 3_000_000],
    [500_000, 80_000, 400_000],
    [1_000_000, 30_000, 80_000],
  ];
  for (const [maxRank, min, max] of bands) {
    if (rank <= maxRank) return { minMonthlyVisits: min, maxMonthlyVisits: max };
  }
  return null;
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
}

interface RankEntry {
  date: string;
  rank: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Разбирает ответ /ranks/domain и выбирает ранг самой свежей даты. */
export function pickLatestRank(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.ranks)) return null;
  const entries: RankEntry[] = parsed.ranks.flatMap((item) => {
    if (!isRecord(item)) return [];
    const date = typeof item.date === "string" ? item.date.slice(0, 10) : "";
    const rank =
      typeof item.rank === "number" && Number.isInteger(item.rank) && item.rank >= 1
        ? item.rank
        : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || rank === null) return [];
    return [{ date, rank }];
  });
  if (entries.length === 0) return null;
  let latest: RankEntry | undefined;
  for (const entry of entries) {
    if (!latest || entry.date > latest.date) latest = entry;
  }
  return latest?.rank ?? null;
}

export class TrancoTrafficProvider {
  private readonly cache = new Map<string, CachedRank>();
  private readonly ttlMs: number;
  private readonly minRequestIntervalMs: number;
  private lastRequestAt = 0;

  constructor(
    private readonly config: TrancoProviderConfig,
    private readonly http: TrafficHttpReader = new SafeHttpClient(),
  ) {
    this.ttlMs = (config.ttlDays ?? DEFAULT_TTL_DAYS) * DAY_MS;
    this.minRequestIntervalMs =
      config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
  }

  /**
   * Совместим с интерфейсом RadarTrafficProvider: возвращает оценку визитов
   * с прозрачной пометкой источника либо null (домена нет в списке).
   */
  async estimate(host: string, measuredAt: Date): Promise<RadarTrafficEstimate | null> {
    const normalized = normalizeHost(host);
    if (!normalized) return null;

    const cached = this.cache.get(normalized);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.rank === null ? null : this.toEstimate(cached.rank, measuredAt);
    }

    let rank: number | null;
    try {
      await this.throttle();
      rank = await this.fetchDomainRank(normalized);
    } catch {
      // API недоступен (сеть/лимиты) -> честно «нет данных»,
      // а не падение инспекции Радара. Негативный результат НЕ кэшируем:
      // следующая проверка попробует снова.
      return null;
    }
    this.cache.set(normalized, { fetchedAt: Date.now(), rank });
    return rank === null ? null : this.toEstimate(rank, measuredAt);
  }

  private toEstimate(rank: number, measuredAt: Date): RadarTrafficEstimate | null {
    const band = rankToMonthlyVisitsBand(rank);
    if (!band) return null;
    return {
      provider: "Tranco (оценка по рангу)",
      measuredAt: measuredAt.toISOString(),
      confidence: "low" as const,
      ...band,
      // Дневная полоса выводится из месячной (широкой) — иначе плитки
      // «Посещений в день» и видео-возможности остаются пустыми.
      minDailyVisits: Math.max(1, Math.round(band.minMonthlyVisits / 30)),
      maxDailyVisits: Math.max(1, Math.round(band.maxMonthlyVisits / 30)),
    };
  }

  /** Лимит Tranco — 1 запрос/сек: выдерживаем интервал между запросами. */
  private async throttle(): Promise<void> {
    if (this.minRequestIntervalMs <= 0) return;
    const wait = this.lastRequestAt + this.minRequestIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }

  /**
   * Ранг домена в свежем дневном списке либо null, если домена нет в списке
   * (пустой массив ranks или 404). Любой другой не-2xx — исключение.
   */
  private async fetchDomainRank(domain: string): Promise<number | null> {
    const url = `https://tranco-list.eu/api/ranks/domain/${encodeURIComponent(domain)}`;
    const response = await this.http.get(url);
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Tranco ranks HTTP ${response.status}`);
    }
    return pickLatestRank(response.body.toString("utf8"));
  }
}
