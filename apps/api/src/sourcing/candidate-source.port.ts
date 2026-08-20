/**
 * A single origin of look-alike partner candidates for the Radar queue.
 *
 * Deliberately not a plugin framework: the sourcing worker builds a plain
 * array of sources and passes it to {@link RadarSourcingService}.
 */
export interface SourcedCandidate {
  /** Human-readable site name; the sourcing pipeline uses the domain. */
  siteName: string;
  /** Public HTTP(S) URL or bare domain, as accepted by the Radar create API. */
  url: string;
  /** Free-form provenance note; logged, not persisted on the candidate. */
  note?: string;
}

export interface CandidateSource {
  /** Stable identifier used in logs (e.g. "seed-list", "link-expansion"). */
  id: string;
  fetchCandidates(): Promise<SourcedCandidate[]>;
}
