import { isIP } from "node:net";
import type { Browser, Route } from "playwright";
import {
  isBlockedHostname,
  isPublicIpAddress,
  resolveHostAddresses,
  type HostResolver,
} from "./network-guard.js";
import { detectPlayersInSources, type PlayerDetection } from "./player-signatures.js";
import type {
  RadarPageRenderer,
  RenderedPageObservation,
  RenderOptions,
} from "./radar-page-renderer.js";

const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
const SETTLE_MS = 2_000;
/** Budget: at most this many pages are rendered per candidate check. */
const MAX_PAGES_PER_RENDER = 3;
/** Resource types a player detector never needs; blocked for speed. */
const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media"]);

export interface PlaywrightPageRendererOptions {
  /** Injected DNS resolver (tests). */
  resolveHost?: HostResolver;
  /**
   * Extra allow-predicate for hostnames, used ONLY by local smoke tests to
   * point the browser at a 127.0.0.1 fixture server. Never set in production.
   */
  allowHost?: (hostname: string) => boolean;
  pageTimeoutMs?: number;
  settleMs?: number;
  logger?: Pick<Console, "warn">;
}

/**
 * L1 headless check on Playwright/Chromium.
 *
 * - The browser instance is process-wide, launched lazily on first use and
 *   reused across renders.
 * - Every request the page makes goes through the same IP/hostname policy as
 *   SafeHttpClient (network-guard.ts): non-HTTP(S) schemes, localhost and
 *   private/special IP ranges are aborted before the browser connects.
 *
 * // ponytail: known ceiling — we resolve DNS ourselves to vet the IPs, but
 * // Chromium then resolves the hostname again for the actual fetch. A
 * // malicious authoritative DNS server can rebind the name to a private IP
 * // between our check and the browser's connect (classic TOCTOU rebinding).
 * // Closing that gap needs a vetting forward proxy or a network-namespace
 * // sandbox; per-request pre-resolution here keeps the cheap 99% of SSRF out
 * // and the residual risk is documented instead of hidden.
 */
export class PlaywrightPageRenderer implements RadarPageRenderer {
  private browserPromise: Promise<Browser | null> | null = null;
  private unavailableLogged = false;
  private readonly resolveHost: HostResolver;
  private readonly allowHost: ((hostname: string) => boolean) | null;
  private readonly pageTimeoutMs: number;
  private readonly settleMs: number;
  private readonly logger: Pick<Console, "warn">;

  constructor(options: PlaywrightPageRendererOptions = {}) {
    this.resolveHost = options.resolveHost ?? resolveHostAddresses;
    this.allowHost = options.allowHost ?? null;
    this.pageTimeoutMs = options.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.logger = options.logger ?? console;
  }

  async render(urls: string[], options: RenderOptions = {}): Promise<RenderedPageObservation[]> {
    const budget = Math.min(options.maxPages ?? MAX_PAGES_PER_RENDER, MAX_PAGES_PER_RENDER);
    const targets = urls.slice(0, Math.max(0, budget));
    if (targets.length === 0) return [];
    const browser = await this.browser();
    if (!browser) return [];
    const results: RenderedPageObservation[] = [];
    for (const url of targets) {
      results.push(await this.renderPage(browser, url, options.timeoutMs ?? this.pageTimeoutMs));
    }
    return results;
  }

  /** Closes the shared browser (worker shutdown and tests). */
  async close(): Promise<void> {
    const browser = await this.browserPromise?.catch(() => null);
    this.browserPromise = null;
    await browser?.close().catch(() => undefined);
  }

  /** Nest lifecycle hook: shuts the shared Chromium down with the process. */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async renderPage(
    browser: Browser,
    url: string,
    timeoutMs: number,
  ): Promise<RenderedPageObservation> {
    // Verdicts are cached per render to avoid re-resolving every asset host.
    const hostVerdicts = new Map<string, Promise<boolean>>();
    const context = await browser.newContext({ javaScriptEnabled: true });
    try {
      await context.route("**/*", (route) => this.vetRequest(route, hostVerdicts));
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForTimeout(this.settleMs);
      const sample = await page.evaluate(() => ({
        iframeUrls: Array.from(document.querySelectorAll("iframe[src]")).map(
          (element) => (element as HTMLIFrameElement).src,
        ),
        scriptUrls: Array.from(document.querySelectorAll("script[src]")).map(
          (element) => (element as HTMLScriptElement).src,
        ),
        videoTagCount: document.querySelectorAll("video").length,
      }));
      const players: PlayerDetection[] = detectPlayersInSources(sample);
      return { url, ok: true, players };
    } catch (error) {
      return {
        url,
        ok: false,
        players: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async vetRequest(route: Route, hostVerdicts: Map<string, Promise<boolean>>) {
    const request = route.request();
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    // Player detection reads iframe[src] attributes from the DOM; the embed
    // content itself is never needed, so subframe navigations are aborted for
    // speed and to avoid fetching third-party player pages.
    if (request.resourceType() === "document" && request.frame().parentFrame()) {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url());
    } catch {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    let verdict = hostVerdicts.get(hostname);
    if (!verdict) {
      verdict = this.isHostAllowed(hostname);
      hostVerdicts.set(hostname, verdict);
    }
    if (await verdict) await route.continue().catch(() => undefined);
    else await route.abort("blockedbyclient").catch(() => undefined);
  }

  private async isHostAllowed(hostname: string): Promise<boolean> {
    if (this.allowHost?.(hostname)) return true;
    if (isBlockedHostname(hostname)) return false;
    if (isIP(hostname)) return isPublicIpAddress(hostname);
    try {
      const addresses = await this.resolveHost(hostname);
      return addresses.length > 0 && addresses.every((address) => isPublicIpAddress(address));
    } catch {
      return false;
    }
  }

  private browser(): Promise<Browser | null> {
    if (!this.browserPromise) {
      this.browserPromise = this.launch();
    }
    return this.browserPromise;
  }

  private async launch(): Promise<Browser | null> {
    try {
      // Lazy dynamic import: the API process must boot even when the optional
      // playwright package or the Chromium binary is missing.
      const { chromium } = await import("playwright");
      return await chromium.launch({ headless: true });
    } catch (error) {
      if (!this.unavailableLogged) {
        this.unavailableLogged = true;
        this.logger.warn(
          JSON.stringify({
            event: "radar.l1-renderer-unavailable",
            message:
              "Playwright/Chromium недоступен — L1-проверка пропускается. " +
              "Установите: npm install -w @embed-os/api playwright && npx playwright install chromium",
            cause: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      // Keep the failed promise cached: repeated renders in a browserless
      // environment should not retry the launch on every candidate.
      return null;
    }
  }
}

/**
 * Builds the production renderer unless L1 is disabled via RADAR_L1_ENABLED=0.
 */
export function playwrightPageRendererFromEnvironment(): RadarPageRenderer | null {
  if (process.env.RADAR_L1_ENABLED === "0") return null;
  return new PlaywrightPageRenderer();
}
