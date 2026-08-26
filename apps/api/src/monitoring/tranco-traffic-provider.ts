import type { RadarTrafficEstimate } from "@embed-os/contracts";
import { SafeHttpClient } from "./safe-http-client.js";
// Тип-only импорт: цикла в рантайме не создаёт.
import type { TrafficHttpReader } from "./radar-traffic-provider.js";

/**
 * Бесплатный провайдер оценки трафика на основе открытого рейтинга Tranco
 * (tranco-list.eu) — агрегированного глобального рейтинга доменов по трафику.
 *
 * Что даёт честно: ФАКТИЧЕСКИЙ глобальный ранг домена (если входит в список)
 * и порядок величины месячных визитов широкой полосой. Это не панельные данные
 * уровня Similarweb — значение помечается провайдером "Tranco (ранг)", чтобы
 * менеджер понимал природу оценки. Домены вне топ-листа -> null («нет данных»).
 *
 * Список кэшируется в памяти процесса на RADAR_TRANKO_TTL_DAYS дней
 * (по умолчанию 7): два HTTP-запроса на обновление, дальше только поиск.
 */

export interface TrancoProviderConfig {
  enabled: boolean;
  /** Коды стран для фильтра списка через запятую ("ru", "ru,kz"); пусто = весь мир. */
  countries?: string;
  /** Сколько строк списка загружать (место в списке = верхняя граница охвата). */
  limit?: number;
  ttlDays?: number;
  timeoutMs?: number;
}

interface CachedList {
  fetchedAt: number;
  /** domain -> место в рейтинге (1 = самый посещаемый). */
  ranks: Map<string, number>;
}

const DEFAULT_LIMIT = 300_000;
const DEFAULT_TTL_DAYS = 7;
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

export class TrancoTrafficProvider {
  private readonly cache = new Map<string, CachedList>();
  private readonly limit: number;
  private readonly ttlMs: number;

  constructor(
    private readonly config: TrancoProviderConfig,
    private readonly http: TrafficHttpReader = new SafeHttpClient(),
  ) {
    this.limit = config.limit ?? DEFAULT_LIMIT;
    this.ttlMs = (config.ttlDays ?? DEFAULT_TTL_DAYS) * DAY_MS;
  }

  /**
   * Совместим с интерфейсом RadarTrafficProvider: возвращает оценку визитов
   * с прозрачной пометкой источника либо null (домена нет в списке).
   */
  async estimate(host: string, measuredAt: Date): Promise<RadarTrafficEstimate | null> {
    const normalized = normalizeHost(host);
    if (!normalized) return null;
    let ranks: Map<string, number>;
    try {
      ranks = await this.ensureList();
    } catch {
      // Список недоступен (сеть/лимиты API) -> честно «нет данных»,
      // а не падение инспекции Радара.
      return null;
    }
    const rank = ranks.get(normalized);
    if (!rank) return null;
    const band = rankToMonthlyVisitsBand(rank);
    if (!band) return null;
    return {
      provider: "Tranco (оценка по рангу)",
      measuredAt: measuredAt.toISOString(),
      confidence: "low" as const,
      ...band,
    };
  }

  /** Загружает/освежает список при устаревании кэша; потокобезопасно по факту. */
  private async ensureList(): Promise<Map<string, number>> {
    const cached = this.cache.get("list");
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached.ranks;

    const listId = await this.fetchLatestListId();
    const rows = await this.downloadRows(listId);
    const ranks = new Map<string, number>();
    for (let index = 0; index < rows.length; index += 1) {
      const line = rows[index]?.trim() ?? "";
      if (!line) continue;
      const commaIndex = line.indexOf(",");
      if (commaIndex === -1) continue;
      const rankNum = Number(line.slice(0, commaIndex));
      const domain = line.slice(commaIndex + 1).trim().toLowerCase();
      if (!domain || !Number.isInteger(rankNum) || rankNum < 1) continue;
      if (!ranks.has(domain)) ranks.set(domain, rankNum);
    }
    this.cache.set("list", { fetchedAt: Date.now(), ranks });
    return ranks;
  }

  private async fetchLatestListId(): Promise<string> {
    const response = await this.http.get(
      `https://tranco-list.eu/api/lists/date/daily?limit=${this.limit}`,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Tranco list-id HTTP ${response.status}`);
    }
    const parsed: unknown = JSON.parse(response.body.toString("utf8"));
    const id =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { list_id?: unknown }).list_id
        : undefined;
    if (typeof id !== "string" || !id.trim()) throw new Error("Tranco list_id is empty");
    return id.trim();
  }

  private async downloadRows(listId: string): Promise<string[]> {
    const params = new URLSearchParams({ limit: String(this.limit) });
    if (this.config.countries?.trim()) {
      params.set("countries", this.config.countries.trim());
    }
    const response = await this.http.get(
      `https://tranco-list.eu/api/lists/download/id/${encodeURIComponent(listId)}?${params}`,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Tranco download HTTP ${response.status}`);
    }
    return response.body.toString("utf8").split("\n");
  }
}
