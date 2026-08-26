import type { RadarDecisionMakerLead, RadarResearch } from "@embed-os/contracts";
import { setTimeout as wait } from "node:timers/promises";

/**
 * Обогащение исследования Радара данными о юрлице: реквизиты (ИНН/ОГРН)
 * со страниц сайта -> официальная карточка ЕГРЮЛ (ФНС, открытые данные) и,
 * при наличии ключа DaData, ФИО и должность руководителя -> готовый ЛПР.
 *
 * Источники:
 *  - ЕГРЮЛ quick-search (egrul.nalog.ru) — без ключа, официальные данные ФНС.
 *  - DaData suggestions/findById (бесплатный тариф) — management (директор).
 *
 * Все сбои сети/API глушатся: обогащение никогда не ломает инспекцию.
 */

export interface LegalEntityCard {
  inn: string;
  fullName: string | null;
  address: string | null;
  ogrn: string | null;
  /** Регион из адреса регистрации («г. Москва» / «Свердловская область»). */
  region?: string | null;
  source: "ЕГРЮЛ (ФНС)";
  checkedAt: string;
}

export interface LegalEnrichmentOptions {
  dadataApiKey?: string | null;
  timeoutMs?: number;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const EGRUL_URL = "https://egrul.nalog.ru/";
const DADATA_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party";

/** ИНН юрлица (10 цифр) или ИП (12), рядом с меткой ИНН. */
export function extractInn(html: string): string | null {
  const match = html.match(/ИНН[^\dА-Яа-я]{0,12}(\d{12}|\d{10})\b/i);
  return match ? (match[1] ?? null) : null;
}

/** ОГРН (13) / ОГРНИП (15) рядом с меткой. */
export function extractOgrn(html: string): string | null {
  const match = html.match(/ОГРН(?:ИП)?[^\dА-Яа-я]{0,12}(\d{15}|\d{13})\b/i);
  return match ? (match[1] ?? null) : null;
}

/** Собирает реквизиты со страницы (для research.legalInn / legalOgrn). */
export function extractRequisites(html: string): { inn: string | null; ogrn: string | null } {
  return { inn: extractInn(html), ogrn: extractOgrn(html) };
}

const REGION_ALIASES: Array<[RegExp, string]> = [
  [/^москва$/, "г. Москва"],
  [/^санкт[-\s]?петербург$/, "г. Санкт-Петербург"],
  [/^севастополь$/, "г. Севастополь"],
  [/^байконур$/, "г. Байконур"],
];

const REGION_WORD_EXPANSIONS: Record<string, string> = {
  обл: "область",
  "обл.": "область",
  респ: "республика",
  "респ.": "республика",
};

/** Родовые слова региона пишутся со строчной («Свердловская область»). */
const GENERIC_REGION_WORDS = new Set(["область", "край", "республика", "округ", "автономный", "автономная"]);

function titleCaseRegionPhrase(words: string[]): string {
  const expanded = words.map((word) => REGION_WORD_EXPANSIONS[word.toLowerCase()] ?? word);
  return expanded
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase();
      // Родовые слова со строчной, кроме первого слова фразы:
      // «Свердловская область», но «Республика Татарстан».
      if (index > 0 && GENERIC_REGION_WORDS.has(lower)) return lower;
      return titleCaseRuWord(word);
    })
    .join(" ");
}

function titleCaseRuWord(word: string): string {
  return word
    .toLocaleLowerCase("ru-RU")
    .split("-")
    .map((part) =>
      part.length <= 2 && /^(на|в|по|с|и|о|об)$/.test(part)
        ? part
        : part.charAt(0).toLocaleUpperCase("ru-RU") + part.slice(1),
    )
    .join("-");
}

/**
 * Регион из официального адреса ЕГРЮЛ («115191, ГОРОД МОСКВА, …»,
 * «191186, Г САНКТ-ПЕТЕРБУРГ, …», «620014, СВЕРДЛОВСКАЯ ОБЛ, …»,
 * «420111, РЕСП ТАТАРСТАН, …»). Возвращает каноничную подпись вида
 * «г. Москва» / «Свердловская область» либо null, если регион не распознан.
 */
export function regionFromEgrulAddress(address: string | null): string | null {
  if (!address) return null;
  const withoutPostal = address.trim().replace(/^\d{6}\s*,?\s*/, "");
  const firstSegment = (withoutPostal.split(",")[0] ?? "").trim();
  if (!firstSegment) return null;
  // «Г.Москва», «Г. МОСКВА», «г Москва» (без точки), «ГОРОД МОСКВА», «гор. Москва».
  const cityMatch = firstSegment.match(/^(?:город\s+|гор\.\s*|г\.\s*|г\s+)(.+)$/i);
  const name = (cityMatch?.[1] ?? firstSegment).trim();
  if (!name) return null;
  const normalizedWords = name.toLocaleLowerCase("ru-RU").split(/\s+/).filter(Boolean);
  // Федеральные города: точное совпадение или первый сегмент («москва ул …»).
  for (const [pattern, label] of REGION_ALIASES) {
    if (pattern.test(normalizedWords[0]?.replace(/\.$/, "") ?? "")) return label;
  }
  return titleCaseRegionPhrase(name.split(/\s+/));
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: Fetcher,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return JSON.parse((await response.text()) || "null");
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Карточка юрлица из ЕГРЮЛ (ФНС) по ИНН. Двухшаговый флоу: POST -> токен,
 *  GET search-result/<токен> -> rows. В rows есть и реквизиты, и поле `g`
 *  вида «ГЕНЕРАЛЬНЫЙ ДИРЕКТОР: Фамилия Имя Отчество» — подтверждённый ЛПР
 *  из открытых данных ФНС, без сторонних сервисов. */
export async function fetchEgrulCard(
  inn: string,
  timeoutMs = 8_000,
  fetcher: Fetcher = fetch,
): Promise<{ card: LegalEntityCard; director: RadarDecisionMakerLead | null; sourceUrl: string } | null> {
  try {
    const body = new URLSearchParams({ vyp3Captcha: "1", page: "", query: inn, Region: "" });
    const tokenParsed = await fetchJson(
      EGRUL_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      timeoutMs,
      fetcher,
    );
    const token = isRecord(tokenParsed) ? str(tokenParsed.t) : null;
    if (!token) return null;

    const resultUrl = `https://egrul.nalog.ru/search-result/${encodeURIComponent(token)}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await wait(1_500);
      const parsed = await fetchJson(resultUrl, { method: "GET" }, timeoutMs, fetcher);
      const rows = isRecord(parsed) && Array.isArray(parsed.rows) ? parsed.rows : [];
      if (rows.length === 0) continue;
      const row = rows.find(
        (item) => isRecord(item) && (item.i === inn || item.i === `00${inn}`),
      ) ?? (rows[0] && isRecord(rows[0]) ? rows[0] : null);
      if (!row) return null;
      const checkedAt = new Date().toISOString();
      const isIndividual = row.k === "ip" || inn.length === 12;
      // В quick-search ЕГРЮЛ полного адреса (`a`) может не быть — регион
      // приходит отдельным коротким полем `rn` («Г.Москва», «Московская обл»).
      const card: LegalEntityCard = {
        inn,
        fullName: str(row.c) ?? str(row.n),
        address: str(row.a),
        ogrn: str(row.o),
        region: regionFromEgrulAddress(str(row.a) ?? str(row.rn)),
        source: "ЕГРЮЛ (ФНС)",
        checkedAt,
      };
      // У ИП поле `g` обычно отсутствует — ФИО предпринимателя сидит в названии
      // записи («ИП Иванов Иван Иванович»), это и есть подтверждённое ЛПР.
      const ipDirector =
        isIndividual && !str(row.g)
          ? ipDirectorFromName(str(row.n))
          : null;
      return {
        card,
        director:
          parseEgrulDirector(str(row.g), checkedAt) ??
          ipDirector,
        sourceUrl: resultUrl,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** «ГЕНЕРАЛЬНЫЙ ДИРЕКТОР: Иванов Иван Иванович» -> ЛПР. */
export function parseEgrulDirector(
  raw: string | null,
  _checkedAt: string,
): RadarDecisionMakerLead | null {
  if (!raw) return null;
  const separator = raw.indexOf(":");
  if (separator === -1) return null;
  const role = raw.slice(0, separator).trim();
  const fullName = raw.slice(separator + 1).trim();
  if (!role || !fullName) return null;
  return {
    fullName,
    role,
    department: "Руководство",
    email: null,
    phone: null,
    profileUrl: null,
    sourceUrl: "https://egrul.nalog.ru/",
    evidence: `Официальные открытые данные ЕГРЮЛ (ФНС): ${raw}`,
    confidence: "high",
  };
}

/** ФИО предпринимателя из названия записи ЕГРЮЛ («ИП Иванов Иван Иванович»). */
export function ipDirectorFromName(
  recordName: string | null,
): RadarDecisionMakerLead | null {
  const name = recordName?.trim();
  if (!name) return null;
  const withoutPrefix = name.replace(/^ИП\s+/i, "").trim();
  // ФИО = три слова, каждое с заглавной (допустим ё).
  if (!/^[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+$/.test(withoutPrefix)) return null;
  return {
    fullName: withoutPrefix,
    role: "Индивидуальный предприниматель",
    department: "Руководство",
    email: null,
    phone: null,
    profileUrl: null,
    sourceUrl: "https://egrul.nalog.ru/",
    evidence: `Официальные открытые данные ЕГРЮЛ (ФНС): ${name}`,
    confidence: "high",
  };
}

interface DadataParty {
  name?: { full_with_opf?: string };
  management?: { name?: string; post?: string };
  address?: { value?: string };
  ogrn?: string;
}

/** Руководитель из DaData (по официальным данным ЕГРЮЛ). */
export async function fetchDirectorLead(
  inn: string,
  apiKey: string,
  sourceUrl: string,
  timeoutMs = 8_000,
  fetcher: Fetcher = fetch,
): Promise<RadarDecisionMakerLead | null> {
  try {
    const parsed = (await fetchJson(
      DADATA_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Token ${apiKey.trim()}`,
        },
        body: JSON.stringify({ query: inn, count: 1 }),
      },
      timeoutMs,
      fetcher,
    )) as { suggestions?: unknown[] } | null;
    const first = parsed?.suggestions?.[0];
    if (!isRecord(first)) return null;
    const party = (first.data ?? {}) as DadataParty;
    const directorName = str(party.management?.name);
    const directorPost = str(party.management?.post);
    if (!directorName) return null;
    return {
      fullName: directorName,
      role: directorPost ?? "Руководитель организации",
      department: null,
      email: null,
      phone: null,
      profileUrl: null,
      sourceUrl,
      evidence: `ЕГРЮЛ/ФНС через DaData: руководитель по ИНН ${inn}`,
      confidence: "high",
    };
  } catch {
    return null;
  }
}

/**
 * Обогащает research: карточка ЕГРЮЛ + (при ключе DaData) руководитель
 * как ЛПР с высокой уверенностью. Оригинал не мутирует.
 */
export async function enrichResearchWithLegalEntity(
  research: RadarResearch,
  options: LegalEnrichmentOptions = {},
  fetcher: Fetcher = fetch,
): Promise<RadarResearch> {
  const inn = research.legalInn?.trim();
  if (!inn) return research;
  const timeoutMs = options.timeoutMs ?? 8_000;

  const dadataKey = options.dadataApiKey?.trim();
  const egrul = await fetchEgrulCard(inn, timeoutMs, fetcher);
  const card = egrul?.card ?? null;
  // Приоритет ЛПР: официальный директор из ЕГРЮЛ; DaData — если ЕГРЮЛ не дал.
  const egrulDirector = egrul?.director ?? null;
  const director =
    egrulDirector ??
    (dadataKey
      ? await fetchDirectorLead(inn, dadataKey, research.pageUrl, timeoutMs, fetcher)
      : null);

  const decisionMakers = director
    ? [
        director,
        ...research.decisionMakers.filter(
          (lead) => lead.fullName?.toLowerCase() !== director.fullName?.toLowerCase(),
        ),
      ]
    : research.decisionMakers;

  // География из официального адреса ФНС — самый надёжный источник региона.
  const legalRegion = card?.region ?? research.legalRegion ?? null;
  const signals =
    legalRegion && !research.signals.some(({ field }) => field === "geography")
      ? [
          ...research.signals,
          {
            field: "geography" as const,
            label: "География",
            value: `${legalRegion}, Россия`,
            source: "Адрес юрлица из ЕГРЮЛ (ФНС)",
            confidence: "high" as const,
          },
        ]
      : research.signals;

  return {
    ...research,
    decisionMakers,
    signals,
    legalEntity: card,
    legalRegion,
  };
}
