import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Shared SSRF guard used by every outbound fetch path (SafeHttpClient and the
 * Playwright page renderer). One implementation, one set of blocked ranges.
 */

export type HostResolver = (hostname: string) => Promise<string[]>;

export class BlockedNetworkTargetError extends Error {
  constructor(readonly target: string) {
    super(`Network target is not allowed: ${target}`);
    this.name = "BlockedNetworkTargetError";
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

/** True for hostnames that must never be fetched regardless of DNS answers. */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    (isIP(normalized) > 0 && !isPublicIpAddress(normalized))
  );
}

export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
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
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
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
