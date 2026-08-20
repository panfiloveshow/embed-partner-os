import { normalizeRadarTarget } from "@embed-os/domain";

/**
 * Normalizes a sourced URL or bare domain to the Radar dedup key: lowercase
 * hostname without `www.`, path, port or trailing dot — exactly the value the
 * Radar stores in `hostNormalized`.
 *
 * Returns `null` for anything the Radar itself would reject (invalid URL,
 * IP address, localhost, technical subdomains), so sourcing can skip the
 * entry instead of failing the whole cycle.
 */
export function normalizeCandidateHost(input: string): string | null {
  try {
    return normalizeRadarTarget(input).hostNormalized;
  } catch {
    return null;
  }
}
