import type {
  RadarConfidence,
  RadarDetectedPlayer,
  RadarEvidenceStatus,
  RadarResearchCoverage,
  RadarVideoPageLead,
} from "@embed-os/contracts";
import { gunzipSync } from "node:zlib";
import {
  applyFeedPublicationFrequency,
  applyLegalRegionToGeography,
  enrichRadarResearchWithDetectedPlayers,
  extractRadarPageFeatures,
  findRadarResearchLinks,
  looksLikeVideoUrl,
  mergeRadarPageExtractions,
  type RadarPageFeatureExtraction,
  } from "./radar-feature-extractor.js";
  import { enrichResearchWithLegalEntity } from "./legal-entity-enrichment.js";
import {
  detectPlayersInHtml,
  toRadarDetectedPlayers,
  type PlayerDetection,
} from "./player-signatures.js";
import type { RadarPageRenderer } from "./radar-page-renderer.js";
import type { RadarTrafficProvider } from "./radar-traffic-provider.js";
import {
  BlockedNetworkTargetError,
  ResponseTooLargeError,
  ROBOTS_PRODUCT_TOKEN,
  SafeHttpClient,
  type SafeHttpResponse,
} from "./safe-http-client.js";

export const RADAR_INSPECTOR = Symbol("RADAR_INSPECTOR");

/**
 * Radar inspections run heavy feature-extraction regexes over the body, so
 * they read at most 1 MB per page instead of the transport default of 5 MB.
 */
const RADAR_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Budget: the L1 renderer receives at most this many candidate URLs. */
const RADAR_L1_MAX_PAGES = 3;

export interface RadarInspectionObservation {
  pageUrl: string;
  status: RadarEvidenceStatus;
  playerType: string | null;
  detectedAt: Date;
  method: "l0-html";
  confidence: RadarConfidence;
  httpStatus: number | null;
  playerFound: boolean;
  embedUrl: string | null;
  errorCode: string | null;
  featureExtraction?: RadarPageFeatureExtraction | null;
  /** Players recognized by the signature catalog across the inspected pages. */
  detectedPlayers?: RadarDetectedPlayer[];
  /** Derived: at least one detected player is a competing video hosting. */
  competitorPlayerDetected?: boolean;
}

export interface RadarInspector {
  inspect(pageUrl: string): Promise<RadarInspectionObservation>;
}

export interface RadarHttpReader {
  get(url: string, options?: { maxBytes?: number }): Promise<SafeHttpResponse>;
}

export class RadarPageInspector implements RadarInspector {
  constructor(
    private readonly http: RadarHttpReader = new SafeHttpClient(),
    private readonly clock: () => Date = () => new Date(),
    private readonly trafficProvider: RadarTrafficProvider | null = null,
    private readonly renderer: RadarPageRenderer | null = null,
  ) {}

  async inspect(pageUrl: string): Promise<RadarInspectionObservation> {
    const checkedAt = this.clock();
    try {
      const parsed = new URL(pageUrl);
      const robotsUrl = new URL("/robots.txt", parsed.origin).toString();
      const robots = await this.http.get(robotsUrl, { maxBytes: RADAR_MAX_RESPONSE_BYTES });
      if (robots.status === 401 || robots.status === 403) {
        return this.observation(
          pageUrl,
          checkedAt,
          "blocked",
          null,
          "low",
          robots.status,
          null,
          "ROBOTS_ACCESS_DENIED",
        );
      }
      if (robots.status >= 200 && robots.status < 300) {
        const path = `${parsed.pathname}${parsed.search}`;
        if (!robotsAllows(robots.body.toString("utf8"), path)) {
          return this.observation(
            pageUrl,
            checkedAt,
            "blocked",
            null,
            "high",
            null,
            null,
            "ROBOTS_DISALLOWED",
          );
        }
      }

      const page = await this.http.get(pageUrl, { maxBytes: RADAR_MAX_RESPONSE_BYTES });
      if (page.status === 403 || page.status === 429) {
        return this.observation(
          page.url.toString(),
          checkedAt,
          "blocked",
          null,
          "high",
          page.status,
          null,
          "PAGE_HTTP_BLOCKED",
        );
      }
      if (page.status < 200 || page.status >= 300) {
        return this.observation(
          page.url.toString(),
          checkedAt,
          "unknown",
          null,
          "low",
          page.status,
          null,
          "PAGE_HTTP_ERROR",
        );
      }
      const contentType = page.headers["content-type"] ?? "";
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        return this.observation(
          page.url.toString(),
          checkedAt,
          "unknown",
          null,
          "low",
          page.status,
          null,
          "PAGE_CONTENT_TYPE_UNSUPPORTED",
        );
      }
      const html = page.body.toString("utf8");
      const staticDetections = new Map<string, PlayerDetection>();
      addDetections(staticDetections, detectPlayersInHtml(html, page.url));
      const extractions = [extractRadarPageFeatures(html, page.url, checkedAt)];
      const robotsSource =
        robots.status >= 200 && robots.status < 300 ? robots.body.toString("utf8") : "";
      if (page.url.origin === parsed.origin) {
        const businessUrls = findRadarResearchLinks(html, page.url, 3);
        const declaredSitemaps = findDeclaredSitemaps(robotsSource, page.url)
          .filter((url) => robotsAllows(robotsSource, `${url.pathname}${url.search}`))
          .slice(0, 3);
        const declaredFeeds = findDeclaredFeeds(html, page.url)
          .filter((url) => robotsAllows(robotsSource, `${url.pathname}${url.search}`))
          .slice(0, 2);
        const sitemapUrls = await this.readSitemapPages(declaredSitemaps, page.url, robotsSource);
        const { urls: feedUrls, pubDates: feedPubDates } = await this.readFeedPages(
          declaredFeeds,
          page.url,
        );
        // Видеостраницы из карты сайта: дешёвое (без дополнительных запросов)
        // расширение оценки «объём страниц с видео».
        const sitemapVideoLeads = sitemapVideoPageLeads(sitemapUrls, page.url);
        const discoveredUrls = uniqueSameOriginUrls(
          [page.url.toString(), ...businessUrls, ...sitemapUrls, ...feedUrls],
          page.url,
          200,
        );
        // Видеоподобные URL из карты сайта проверяем первыми — иначе разделы
        // /video/ не попадают в лимит доп. страниц и фактор видео пустует.
        const prioritizedSitemapUrls = [...sitemapUrls].sort((left, right) => {
          const leftVideo = Number(looksLikeVideoUrl(new URL(left, page.url)));
          const rightVideo = Number(looksLikeVideoUrl(new URL(right, page.url)));
          return rightVideo - leftVideo;
        });
        const pageCandidates = uniqueSameOriginUrls(
          [...businessUrls, ...prioritizedSitemapUrls.slice(0, 6), ...feedUrls.slice(0, 4)],
          page.url,
          11,
        ).filter((url) => url !== page.url.toString());
        const linkedExtractions = await Promise.all(
          pageCandidates.map(async (linkedUrl) => {
            const linked = new URL(linkedUrl);
            if (!robotsAllows(robotsSource, `${linked.pathname}${linked.search}`)) return null;
            try {
              const linkedPage = await this.http.get(linkedUrl, {
                maxBytes: RADAR_MAX_RESPONSE_BYTES,
              });
              const linkedType = linkedPage.headers["content-type"] ?? "";
              if (
                linkedPage.url.origin === page.url.origin &&
                linkedPage.status >= 200 &&
                linkedPage.status < 300 &&
                (!linkedType || /text\/html|application\/xhtml\+xml/i.test(linkedType))
              ) {
                const linkedHtml = linkedPage.body.toString("utf8");
                addDetections(staticDetections, detectPlayersInHtml(linkedHtml, linkedPage.url));
                return extractRadarPageFeatures(linkedHtml, linkedPage.url, checkedAt);
              }
            } catch {
              // A secondary research page must not invalidate the primary page inspection.
            }
            return null;
          }),
        );
        extractions.push(
          ...linkedExtractions.filter((item): item is RadarPageFeatureExtraction => item !== null),
        );

        const videoPagesObserved = new Set(
          extractions.flatMap(({ research }) =>
            research.videoPages.map(({ pageUrl: videoPageUrl }) => videoPageUrl),
          ),
        ).size;
        const coverage: RadarResearchCoverage = {
          discoveredUrls: discoveredUrls.length,
          inspectedUrls: extractions.length,
          sitemapUrls: sitemapUrls.length,
          feedUrls: feedUrls.length,
          videoPagesObserved,
          coveragePercent:
            discoveredUrls.length > 0
              ? Math.min(100, Math.round((extractions.length / discoveredUrls.length) * 100))
              : 100,
        };
        let trafficEstimate = null;
        if (this.trafficProvider) {
          try {
            trafficEstimate = await this.trafficProvider.estimate(
              page.url.hostname.replace(/^www\./, ""),
              checkedAt,
            );
          } catch {
            // Provider failures do not turn a valid page inspection into an error.
          }
        }
        let extraction = mergeRadarPageExtractions(
          extractions,
          trafficEstimate,
          coverage,
          sitemapVideoLeads,
        );
        // Частота публикаций из дат RSS/Atom-ленты — если по страницам она
        // не определилась (ловушка №8: присваиваем результат).
        extraction = applyFeedPublicationFrequency(extraction, feedPubDates);
        // Обогащение по реквизитам: ЕГРЮЛ (ФНС) + руководитель (DaData).
        extraction.research = await enrichResearchWithLegalEntity(extraction.research, {
          dadataApiKey: process.env.DADATA_API_KEY ?? null,
        });
        // Регион из официального адреса ФНС -> фактор «Целевая география».
        extraction = applyLegalRegionToGeography(extraction);
        // Fresh RSS articles are the most likely places to carry an embedded
        // player; without a feed we fall back to the checked business pages.
        const l1Candidates = [
          page.url.toString(),
          ...(feedUrls.length > 0 ? feedUrls : pageCandidates),
        ];
        return this.finalize(page, checkedAt, html, extraction, staticDetections, l1Candidates);
      }
      let trafficEstimate = null;
      if (this.trafficProvider) {
        try {
          trafficEstimate = await this.trafficProvider.estimate(
            page.url.hostname.replace(/^www\./, ""),
            checkedAt,
          );
        } catch {
          // Provider failures do not turn a valid page inspection into an error.
        }
      }
      let extraction = mergeRadarPageExtractions(extractions, trafficEstimate);
      // Обогащение по реквизитам: ЕГРЮЛ (ФНС) + руководитель (DaData).
      extraction.research = await enrichResearchWithLegalEntity(extraction.research, {
        dadataApiKey: process.env.DADATA_API_KEY ?? null,
      });
      // Регион из официального адреса ФНС -> фактор «Целевая география».
      extraction = applyLegalRegionToGeography(extraction);
      return this.finalize(page, checkedAt, html, extraction, staticDetections, [
        page.url.toString(),
      ]);
    } catch (error) {
      if (error instanceof BlockedNetworkTargetError) {
        return this.observation(
          pageUrl,
          checkedAt,
          "blocked",
          null,
          "high",
          null,
          null,
          "NETWORK_TARGET_BLOCKED",
        );
      }
      if (error instanceof ResponseTooLargeError) {
        return this.observation(
          pageUrl,
          checkedAt,
          "unknown",
          null,
          "low",
          null,
          null,
          "RESPONSE_TOO_LARGE",
        );
      }
      const code =
        error instanceof Error && error.name === "TimeoutError"
          ? "NETWORK_TIMEOUT"
          : "NETWORK_ERROR";
      return this.observation(pageUrl, checkedAt, "unknown", null, "low", null, null, code);
    }
  }

  /**
   * Shared tail of an inspection: applies the signature catalog to the static
   * result, escalates to the L1 headless renderer when static analysis found
   * nothing, and produces the final observation.
   */
  private async finalize(
    page: SafeHttpResponse,
    checkedAt: Date,
    html: string,
    baseExtraction: RadarPageFeatureExtraction,
    staticDetections: Map<string, PlayerDetection>,
    l1Candidates: string[],
  ): Promise<RadarInspectionObservation> {
    const legacyPlayer = findVideoPattern(html);
    const detectedPlayers: RadarDetectedPlayer[] = toRadarDetectedPlayers(
      [...staticDetections.values()],
      "static",
    );
    // L1 runs only when the cheap static pass found no video patterns at all:
    // the page is reachable, so an empty result may simply mean a JS-inserted
    // player. Disabled with RADAR_L1_ENABLED=0 or without a renderer binding.
    if (
      !legacyPlayer &&
      staticDetections.size === 0 &&
      this.renderer &&
      process.env.RADAR_L1_ENABLED !== "0"
    ) {
      try {
        const targets = [...new Set(l1Candidates)].slice(0, RADAR_L1_MAX_PAGES);
        const rendered = await this.renderer.render(targets, { maxPages: RADAR_L1_MAX_PAGES });
        const renderedDetections = new Map<string, PlayerDetection>();
        for (const result of rendered) {
          if (result.ok) addDetections(renderedDetections, result.players);
        }
        detectedPlayers.push(
          ...toRadarDetectedPlayers([...renderedDetections.values()], "rendered"),
        );
      } catch {
        // L1 is best-effort: a renderer failure never invalidates the L0 result.
      }
    }
    const extraction = enrichRadarResearchWithDetectedPlayers(baseExtraction, detectedPlayers);
    // The catalog names the vendor precisely, so it wins over the legacy
    // generic "Embed player" heuristic; specific legacy matches stay intact.
    const catalogPlayer = playerFromDetections(detectedPlayers);
    const player =
      legacyPlayer && legacyPlayer.playerType !== "Embed player"
        ? legacyPlayer
        : (catalogPlayer ?? legacyPlayer);
    if (!player) {
      return this.observation(
        page.url.toString(),
        checkedAt,
        "not_found",
        null,
        "medium",
        page.status,
        null,
        "VIDEO_PATTERN_NOT_FOUND",
        extraction,
        detectedPlayers,
      );
    }
    return this.observation(
      page.url.toString(),
      checkedAt,
      "found",
      player.playerType,
      player.confidence,
      page.status,
      player.embedUrl,
      null,
      extraction,
      detectedPlayers,
    );
  }

  private async readSitemapPages(sitemaps: URL[], pageUrl: URL, robotsSource: string) {
    const pages: string[] = [];
    const childSitemaps: URL[] = [];
    const responses = await Promise.all(sitemaps.map((url) => this.readXml(url, pageUrl)));
    for (const response of responses) {
      if (!response) continue;
      const locations = xmlLocations(response.body);
      if (/<sitemapindex\b/i.test(response.body)) {
        // Выделенные видеосайтмапы (…/video/sitemap…) часто глубоко в индексе —
        // поднимаем их в первые 3, иначе фактор видео остаётся пустым.
        const prioritized = [...locations].sort(
          (left, right) => Number(/video/i.test(right)) - Number(/video/i.test(left)),
        );
        childSitemaps.push(...sameOriginUrls(prioritized, response.url, pageUrl, 3));
      } else {
        pages.push(
          ...sameOriginUrls(locations, response.url, pageUrl, 200).map((url) => url.toString()),
        );
      }
    }
    const allowedChildren = childSitemaps
      .filter((url) => robotsAllows(robotsSource, `${url.pathname}${url.search}`))
      .slice(0, 3);
    const childResponses = await Promise.all(
      allowedChildren.map((url) => this.readXml(url, pageUrl)),
    );
    for (const response of childResponses) {
      if (!response) continue;
      pages.push(
        ...sameOriginUrls(xmlLocations(response.body), response.url, pageUrl, 200).map((url) =>
          url.toString(),
        ),
      );
    }
    return uniqueSameOriginUrls(pages, pageUrl, 200);
  }

  private async readFeedPages(feeds: URL[], pageUrl: URL): Promise<{
    urls: string[];
    pubDates: string[];
  }> {
    const pages: string[] = [];
    const pubDates: string[] = [];
    const responses = await Promise.all(feeds.map((url) => this.readXml(url, pageUrl)));
    for (const response of responses) {
      if (!response) continue;
      pubDates.push(...xmlFeedPubDates(response.body));
      pages.push(
        ...sameOriginUrls(xmlFeedLinks(response.body), response.url, pageUrl, 100).map((url) =>
          url.toString(),
        ),
      );
    }
    return { urls: uniqueSameOriginUrls(pages, pageUrl, 100), pubDates };
  }

  private async readXml(url: URL, pageUrl: URL): Promise<{ url: URL; body: string } | null> {
    try {
      const response = await this.http.get(url.toString(), {
        maxBytes: RADAR_MAX_RESPONSE_BYTES,
      });
      const contentType = response.headers["content-type"] ?? "";
      // lenta.ru и другие отдают .gz-сайтмапы как application/octet-stream —
      // content-type не фильтруем жёстко: битый контент даст пустой парс.
      if (
        response.url.origin !== pageUrl.origin ||
        response.status < 200 ||
        response.status >= 300 ||
        (contentType && !/xml|rss|atom|gzip|octet-stream/i.test(contentType))
      )
        return null;
      return { url: response.url, body: this.decodeXmlBody(response.body) };
    } catch {
      return null;
    }
  }

  /** Многие сайты отдают sitemap только в gzip (…xml.gz) — распознаём по магии. */
  private decodeXmlBody(body: Buffer): string {
    if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
      try {
        return gunzipSync(body).toString("utf8");
      } catch {
        // Битый gzip — вернём как есть: парсер тегов вернёт пусто.
      }
    }
    return body.toString("utf8");
  }

  private observation(
    pageUrl: string,
    detectedAt: Date,
    status: RadarEvidenceStatus,
    playerType: string | null,
    confidence: RadarConfidence,
    httpStatus: number | null,
    embedUrl: string | null,
    errorCode: string | null,
    featureExtraction: RadarPageFeatureExtraction | null = null,
    detectedPlayers: RadarDetectedPlayer[] = [],
  ): RadarInspectionObservation {
    return {
      pageUrl,
      status,
      playerType,
      detectedAt,
      method: "l0-html",
      confidence,
      httpStatus,
      playerFound: status === "found",
      embedUrl,
      errorCode,
      featureExtraction,
      detectedPlayers,
      competitorPlayerDetected: detectedPlayers.some(({ competitor }) => competitor),
    };
  }
}

function addDetections(target: Map<string, PlayerDetection>, detections: PlayerDetection[]) {
  for (const detection of detections) {
    if (!target.has(detection.vendor)) target.set(detection.vendor, detection);
  }
}

/** Видеостраницы, найденные в карте сайта (без дополнительных запросов). */
export function sitemapVideoPageLeads(
  sitemapUrls: string[],
  pageUrl: URL,
  limit = 200,
): RadarVideoPageLead[] {
  const leads: RadarVideoPageLead[] = [];
  const seen = new Set<string>();
  for (const raw of sitemapUrls) {
    try {
      const url = new URL(raw);
      url.hash = "";
      if (!looksLikeVideoUrl(url)) continue;
      const key = url.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      leads.push({
        pageUrl: key,
        label: url.pathname,
        sourceUrl: pageUrl.toString(),
        confidence: "low",
      });
    } catch {
      // Malformed sitemap entries are skipped.
    }
    if (leads.length >= limit) break;
  }
  return leads;
}

/**
 * Chooses the observation-level player when the legacy primary-page pattern
 * missed but the catalog matched. Competitor iframes carry the strongest
 * signal (a working third-party embed), then any iframe, then the rest.
 */
function playerFromDetections(detectedPlayers: RadarDetectedPlayer[]): {
  playerType: string;
  embedUrl: string | null;
  confidence: RadarConfidence;
} | null {
  if (detectedPlayers.length === 0) return null;
  const rank = (player: RadarDetectedPlayer) =>
    (player.competitor ? 0 : 2) + (player.sampleUrl ? 0 : 1);
  const best = [...detectedPlayers].sort((left, right) => rank(left) - rank(right))[0]!;
  return {
    playerType: best.label,
    embedUrl: best.sampleUrl ?? null,
    // Catalog matches on secondary/rendered pages are strong but indirect
    // evidence for the primary page, so they never claim "high" on their own.
    confidence: "medium",
  };
}

function findDeclaredSitemaps(robotsSource: string, pageUrl: URL) {
  const urls: URL[] = [];
  for (const rawLine of robotsSource.split(/\r?\n/)) {
    const line = (rawLine.split("#", 1)[0] ?? "").trim();
    const match = line.match(/^sitemap\s*:\s*(.+)$/i);
    if (!match?.[1]) continue;
    const url = safeSameOriginUrl(match[1].trim(), pageUrl, pageUrl);
    if (url) urls.push(url);
  }
  return uniqueUrls(urls, 3);
}

function findDeclaredFeeds(html: string, pageUrl: URL) {
  const urls: URL[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = htmlAttributeFromTag(tag, "rel") ?? "";
    const type = htmlAttributeFromTag(tag, "type") ?? "";
    const href = htmlAttributeFromTag(tag, "href");
    if (!href || !/\balternate\b/i.test(rel) || !/(?:rss|atom)\+xml/i.test(type)) continue;
    const url = safeSameOriginUrl(href, pageUrl, pageUrl);
    if (url) urls.push(url);
  }
  return uniqueUrls(urls, 2);
}

function xmlLocations(xml: string) {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeXml((match[1] ?? "").trim()))
    .filter(Boolean);
}

function xmlFeedLinks(xml: string) {
  const textLinks = [...xml.matchAll(/<link\b(?![^>]*\bhref\s*=)[^>]*>([\s\S]*?)<\/link>/gi)].map(
    (match) => decodeXml((match[1] ?? "").trim()),
  );
  const hrefLinks = [
    ...xml.matchAll(/<link\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))[^>]*>/gi),
  ].map((match) => decodeXml((match[1] ?? match[2] ?? match[3] ?? "").trim()));
  return [...textLinks, ...hrefLinks].filter(Boolean);
}

/** Даты публикаций из RSS (pubDate) и Atom (published/updated). */
function xmlFeedPubDates(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(
    /<(?:pubDate|published|updated)\b[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/gi,
  )) {
    const value = decodeXml((match[1] ?? "").trim());
    if (value) values.push(value);
  }
  return values;
}

function sameOriginUrls(values: string[], baseUrl: URL, pageUrl: URL, limit: number) {
  const urls = values.flatMap((value) => {
    const url = safeSameOriginUrl(value, baseUrl, pageUrl);
    return url ? [url] : [];
  });
  return uniqueUrls(urls, limit);
}

function uniqueSameOriginUrls(values: string[], pageUrl: URL, limit: number) {
  return uniqueUrls(
    values.flatMap((value) => {
      const url = safeSameOriginUrl(value, pageUrl, pageUrl);
      return url ? [url] : [];
    }),
    limit,
  ).map((url) => url.toString());
}

function safeSameOriginUrl(value: string, baseUrl: URL, pageUrl: URL) {
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== pageUrl.origin || !/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function uniqueUrls(urls: URL[], limit: number) {
  return [...new Map(urls.map((url) => [url.toString(), url])).values()].slice(
    0,
    Math.max(0, limit),
  );
}

function htmlAttributeFromTag(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, "i"),
  );
  return decodeXml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "") || null;
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function findVideoPattern(html: string): {
  playerType: string;
  embedUrl: string | null;
  confidence: RadarConfidence;
} | null {
  const iframeTags = html.match(/<iframe\b[^>]*>/gi) ?? [];
  for (const tag of iframeTags) {
    const source = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const raw = (source?.[1] ?? source?.[2] ?? source?.[3])?.replace(/&amp;/gi, "&");
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    } catch {
      continue;
    }
    const host = url.hostname.toLocaleLowerCase("en-US");
    if (host === "rutube.ru" && /^\/play\/embed\//.test(url.pathname)) {
      return { playerType: "RUTUBE", embedUrl: url.toString(), confidence: "high" };
    }
    if (
      (host === "www.youtube.com" ||
        host === "youtube.com" ||
        host === "www.youtube-nocookie.com") &&
      /^\/embed\//.test(url.pathname)
    ) {
      return { playerType: "YouTube", embedUrl: url.toString(), confidence: "high" };
    }
    if (host === "player.vimeo.com" && /^\/video\//.test(url.pathname)) {
      return { playerType: "Vimeo", embedUrl: url.toString(), confidence: "high" };
    }
    if (/player|video|embed/i.test(`${host}${url.pathname}`)) {
      return { playerType: "Embed player", embedUrl: url.toString(), confidence: "medium" };
    }
  }
  if (/<video\b[^>]*>/i.test(html)) {
    return { playerType: "HTML5 video", embedUrl: null, confidence: "high" };
  }
  if (/\bvideo-js\b|\bvideojs\s*\(/i.test(html)) {
    return { playerType: "Video.js", embedUrl: null, confidence: "medium" };
  }
  return null;
}

export function robotsAllows(source: string, path: string) {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let rulesStarted = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = (rawLine.split("#", 1)[0] ?? "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLocaleLowerCase("en-US");
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || rulesStarted) {
        current = { agents: [], rules: [] };
        groups.push(current);
        rulesStarted = false;
      }
      current.agents.push(value.toLocaleLowerCase("en-US"));
    } else if ((field === "allow" || field === "disallow") && current) {
      rulesStarted = true;
      if (value) current.rules.push({ allow: field === "allow", path: value });
    }
  }
  const exact = groups.filter(({ agents }) => agents.includes(ROBOTS_PRODUCT_TOKEN));
  const applicable = exact.length > 0 ? exact : groups.filter(({ agents }) => agents.includes("*"));
  const matches = applicable
    .flatMap(({ rules }) => rules)
    .filter((rule) => path.startsWith(rule.path))
    .sort(
      (left, right) =>
        right.path.length - left.path.length || Number(right.allow) - Number(left.allow),
    );
  return matches[0]?.allow ?? true;
}
