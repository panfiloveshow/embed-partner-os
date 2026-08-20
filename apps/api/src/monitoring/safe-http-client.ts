import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import {
  BlockedNetworkTargetError,
  isBlockedHostname,
  isPublicIpAddress,
  resolveHostAddresses,
  type HostResolver,
} from "./network-guard.js";

// The IP/hostname policy lives in ./network-guard.ts so the Playwright page
// renderer applies exactly the same rules. Re-exported for existing importers.
export { BlockedNetworkTargetError, isPublicIpAddress, type HostResolver };

/**
 * Single product token shared by the outgoing User-Agent header and the
 * robots.txt group lookup so partner sites can target one agent name.
 */
export const USER_AGENT_PRODUCT_TOKEN = "EmbedPartnerOS-Radar";
export const USER_AGENT = `${USER_AGENT_PRODUCT_TOKEN}/0.1`;
export const ROBOTS_PRODUCT_TOKEN = USER_AGENT_PRODUCT_TOKEN.toLocaleLowerCase("en-US");

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeHttpResponse {
  url: URL;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface SafeHttpRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  signal: AbortSignal;
  maxBytes: number;
}

export type SafeHttpRequester = (input: SafeHttpRequest) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}>;

export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`HTTP response exceeds ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export class SafeHttpClient {
  constructor(
    private readonly resolver: HostResolver = resolveHostAddresses,
    private readonly requester: SafeHttpRequester = nodeRequest,
  ) {}

  async get(
    input: string,
    options: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
  ): Promise<SafeHttpResponse> {
    const timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      100,
      15_000,
      "timeoutMs",
    );
    const maxBytes = boundedInteger(
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      1,
      DEFAULT_MAX_BYTES,
      "maxBytes",
    );
    const maxRedirects = boundedInteger(
      options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      0,
      DEFAULT_MAX_REDIRECTS,
      "maxRedirects",
    );
    const signal = AbortSignal.timeout(timeoutMs);
    let current = parseAllowedUrl(input);

    for (let redirectCount = 0; ; redirectCount += 1) {
      const addresses = await this.resolver(current.hostname);
      if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
        throw new BlockedNetworkTargetError(current.hostname);
      }
      const address = addresses[0];
      if (!address) throw new BlockedNetworkTargetError(current.hostname);
      const family = isIP(address);
      if (family !== 4 && family !== 6) throw new BlockedNetworkTargetError(address);
      const response = await this.requester({ url: current, address, family, signal, maxBytes });
      const location = response.headers.location;
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return { ...response, url: current };
      }
      if (redirectCount >= maxRedirects) throw new Error("HTTP redirect limit exceeded");
      current = parseAllowedUrl(new URL(location, current).toString());
    }
  }
}

function parseAllowedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BlockedNetworkTargetError(input);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new BlockedNetworkTargetError(input);
  }
  if (isBlockedHostname(url.hostname)) {
    throw new BlockedNetworkTargetError(url.hostname);
  }
  url.hash = "";
  return url;
}

const nodeRequest: SafeHttpRequester = ({ url, address, family, signal, maxBytes }) =>
  new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        signal,
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": USER_AGENT,
        },
        lookup: createPinnedLookup(address, family),
      },
      (response) => {
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (declaredLength > maxBytes) {
          request.destroy(new ResponseTooLargeError(maxBytes));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > maxBytes) {
            request.destroy(new ResponseTooLargeError(maxBytes));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: normalizeHeaders(response.headers),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });

export function createPinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      const normalized = Array.isArray(value) ? value[0] : value;
      return normalized === undefined ? [] : [[name.toLowerCase(), normalized]];
    }),
  );
}

function boundedInteger(value: number, min: number, max: number, name: string) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
