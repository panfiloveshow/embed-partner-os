import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

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

export type HostResolver = (hostname: string) => Promise<string[]>;

export class BlockedNetworkTargetError extends Error {
  constructor(readonly target: string) {
    super(`Network target is not allowed: ${target}`);
    this.name = "BlockedNetworkTargetError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`HTTP response exceeds ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export class SafeHttpClient {
  constructor(
    private readonly resolver: HostResolver = resolveHost,
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

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const groups = parseIpv6(address);
  if (!groups) return false;
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0 || groups[5] === 0xffff)
  ) {
    const ipv4 = `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
    return isPublicIpv4(ipv4);
  }
  const [first = 0, second = 0] = groups;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  return true;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 0 && c === 2))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    const parts = ipv4.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null;
    }
    normalized = `${normalized.slice(0, lastColon)}:${(((parts[0] ?? 0) << 8) | (parts[1] ?? 0)).toString(16)}:${(((parts[2] ?? 0) << 8) | (parts[3] ?? 0)).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const values = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
  if (
    values.length !== 8 ||
    values.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)
  ) {
    return null;
  }
  return values;
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
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (isIP(hostname) > 0 && !isPublicIpAddress(hostname))
  ) {
    throw new BlockedNetworkTargetError(hostname);
  }
  url.hash = "";
  return url;
}

async function resolveHost(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
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
          "User-Agent": "EmbedPartnerOS-L0/0.1",
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
