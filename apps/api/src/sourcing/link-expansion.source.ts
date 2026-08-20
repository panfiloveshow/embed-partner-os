import type { SafeHttpClient } from "../monitoring/safe-http-client.js";
import type { CandidateSource, SourcedCandidate } from "./candidate-source.port.js";

export const LINK_EXPANSION_SOURCE_ID = "link-expansion";

/** Max look-alike domains collected from one partner homepage. */
export const MAX_DOMAINS_PER_SITE = 10;
/** Max partner homepages fetched per sourcing cycle. */
export const MAX_SITES_PER_CYCLE = 5;

const HOMEPAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Social networks, big aggregators and infrastructure hosts that are never
 * embed partners. Matched by exact host or any subdomain.
 */
const EXCLUDED_DOMAINS = [
  "vk.com",
  "vk.ru",
  "ok.ru",
  "mail.ru",
  "t.me",
  "telegram.org",
  "dzen.ru",
  "yandex.ru",
  "ya.ru",
  "rambler.ru",
  "rutube.ru",
  "youtube.com",
  "youtu.be",
  "google.ru",
  "google.com",
  "twitch.tv",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "wikipedia.org",
  "livejournal.com",
  "livejournal.ru",
  "hh.ru",
  "avito.ru",
  "ozon.ru",
  "wildberries.ru",
  "aliexpress.ru",
  "gosuslugi.ru",
  "sberbank.ru",
  "liveinternet.ru",
  "top.mail.ru",
];

/** Roots (accepted candidates / partner organizations) to expand from. */
export interface ExpansionRootStore {
  listExpansionRoots(limit: number): Promise<string[]>;
}

/**
 * Extracts external `.ru`/`.рф` media domains linked from a page. Skips the
 * page's own host (and its subdomains) and the social/aggregator blocklist.
 */
export function extractExternalMediaDomains(
  html: string,
  baseHost: string,
  max: number = MAX_DOMAINS_PER_SITE,
): string[] {
  const base = normalizeHost(baseHost) ?? baseHost;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    if (found.length >= max) break;
    const raw = match[1];
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw, `https://${base}/`);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const host = normalizeHost(url.hostname);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    if (!isRussianMediaTld(host)) continue;
    if (host === base || host.endsWith(`.${base}`) || base.endsWith(`.${host}`)) continue;
    if (isExcluded(host)) continue;
    found.push(host);
  }
  return found;
}

/**
 * Look-alike discovery: takes the homepages of already accepted partners
 * (one page per site, via SafeHttpClient with full SSRF protection) and
 * collects outgoing links to external `.ru`/`.рф` media domains.
 */
export class LinkExpansionCandidateSource implements CandidateSource {
  readonly id = LINK_EXPANSION_SOURCE_ID;

  constructor(
    private readonly roots: ExpansionRootStore,
    private readonly http: Pick<SafeHttpClient, "get">,
    private readonly maxSites: number = MAX_SITES_PER_CYCLE,
    private readonly maxDomainsPerSite: number = MAX_DOMAINS_PER_SITE,
  ) {}

  async fetchCandidates(): Promise<SourcedCandidate[]> {
    const roots = await this.roots.listExpansionRoots(this.maxSites);
    const candidates: SourcedCandidate[] = [];
    const seen = new Set<string>(roots);
    for (const rootHost of roots) {
      let html: string;
      try {
        const response = await this.http.get(`https://${rootHost}/`, {
          maxBytes: HOMEPAGE_MAX_BYTES,
        });
        if (response.status !== 200) continue;
        html = response.body.toString("utf8");
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "radar-sourcing.link-expansion-fetch-failed",
            rootHost,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      for (const domain of extractExternalMediaDomains(html, rootHost, this.maxDomainsPerSite)) {
        if (seen.has(domain)) continue;
        seen.add(domain);
        candidates.push({
          siteName: domain,
          url: `https://${domain}/`,
          note: `найден по ссылке с ${rootHost}`,
        });
      }
    }
    return candidates;
  }
}

function normalizeHost(hostname: string): string | null {
  const host = hostname
    .toLocaleLowerCase("en-US")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return host.includes(".") ? host : null;
}

function isRussianMediaTld(host: string): boolean {
  return host.endsWith(".ru") || host.endsWith(".рф") || host.endsWith(".xn--p1ai");
}

function isExcluded(host: string): boolean {
  return EXCLUDED_DOMAINS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}
