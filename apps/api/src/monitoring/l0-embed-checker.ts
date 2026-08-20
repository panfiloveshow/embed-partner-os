import type { L0CheckResult } from "@embed-os/contracts";
import {
  BlockedNetworkTargetError,
  ResponseTooLargeError,
  SafeHttpClient,
  type SafeHttpResponse,
} from "./safe-http-client.js";

export interface HttpReader {
  get(url: string): Promise<SafeHttpResponse>;
}

export interface L0CheckObservation {
  checkedAt: Date;
  result: L0CheckResult;
  pageHttpStatus: number | null;
  embedHttpStatus: number | null;
  playerFound: boolean;
  embedUrl: string | null;
  errorCode: string | null;
  durationMs: number;
}

export class L0EmbedChecker {
  constructor(
    private readonly http: HttpReader = new SafeHttpClient(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async check(pageUrl: string): Promise<L0CheckObservation> {
    const startedAt = this.clock();
    try {
      const page = await this.http.get(pageUrl);
      if (page.status === 403 || page.status === 429) {
        return this.result(
          startedAt,
          "blocked",
          page.status,
          null,
          false,
          null,
          "PAGE_HTTP_BLOCKED",
        );
      }
      if (!isSuccessful(page.status)) {
        return this.result(startedAt, "failed", page.status, null, false, null, "PAGE_HTTP_ERROR");
      }
      const embedUrl = findDocumentedRutubeEmbed(page.body.toString("utf8"));
      if (!embedUrl) {
        return this.result(
          startedAt,
          "failed",
          page.status,
          null,
          false,
          null,
          "RUTUBE_IFRAME_NOT_FOUND",
        );
      }
      const embed = await this.http.get(embedUrl);
      if (embed.status === 403 || embed.status === 429) {
        return this.result(
          startedAt,
          "blocked",
          page.status,
          embed.status,
          true,
          embedUrl,
          "EMBED_HTTP_BLOCKED",
        );
      }
      if (!isSuccessful(embed.status)) {
        return this.result(
          startedAt,
          "failed",
          page.status,
          embed.status,
          true,
          embedUrl,
          "EMBED_HTTP_ERROR",
        );
      }
      return this.result(startedAt, "healthy", page.status, embed.status, true, embedUrl, null);
    } catch (error) {
      if (error instanceof BlockedNetworkTargetError) {
        return this.result(startedAt, "blocked", null, null, false, null, "NETWORK_TARGET_BLOCKED");
      }
      if (error instanceof ResponseTooLargeError) {
        return this.result(startedAt, "unknown", null, null, false, null, "RESPONSE_TOO_LARGE");
      }
      const code =
        error instanceof Error && error.name === "TimeoutError"
          ? "NETWORK_TIMEOUT"
          : "NETWORK_ERROR";
      return this.result(startedAt, "unknown", null, null, false, null, code);
    }
  }

  private result(
    startedAt: Date,
    result: L0CheckResult,
    pageHttpStatus: number | null,
    embedHttpStatus: number | null,
    playerFound: boolean,
    embedUrl: string | null,
    errorCode: string | null,
  ): L0CheckObservation {
    const checkedAt = this.clock();
    return {
      checkedAt,
      result,
      pageHttpStatus,
      embedHttpStatus,
      playerFound,
      embedUrl,
      errorCode,
      durationMs: Math.max(0, checkedAt.getTime() - startedAt.getTime()),
    };
  }
}

export function findDocumentedRutubeEmbed(html: string): string | null {
  const iframeTags = html.match(/<iframe\b[^>]*>/gi) ?? [];
  for (const tag of iframeTags) {
    const source = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const raw = (source?.[1] ?? source?.[2] ?? source?.[3])?.replace(/&amp;/gi, "&");
    if (!raw || (!raw.startsWith("https://") && !raw.startsWith("//"))) continue;
    let url: URL;
    try {
      url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    } catch {
      continue;
    }
    if (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "rutube.ru" &&
      /^\/play\/embed\/[^/?#]+\/?$/.test(url.pathname)
    ) {
      return url.toString();
    }
  }
  return null;
}

function isSuccessful(status: number) {
  return status >= 200 && status < 300;
}
