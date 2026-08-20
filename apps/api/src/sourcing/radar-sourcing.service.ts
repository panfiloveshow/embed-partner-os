import type { RadarPort } from "../radar.port.js";
import type { CandidateSource } from "./candidate-source.port.js";
import { normalizeCandidateHost } from "./domain-normalization.js";
import type { SourcingDedupStore } from "./sourcing-store.js";

/** `source` value of automatically discovered candidates ("Автопоиск" in UI). */
export const RADAR_SOURCE_AUTO = "auto";

export interface SourcingCycleResult {
  /** Raw entries returned by all sources. */
  fetched: number;
  /** Candidates actually created (each with a requested inspection). */
  created: number;
  /** Silently skipped: domain already a candidate/partner or repeated. */
  skippedDuplicates: number;
  /** Entries the Radar would reject (invalid URL, IP, technical subdomain). */
  skippedInvalid: number;
  /** Sources whose fetch failed entirely. */
  failedSources: number;
  /** Individual candidates whose create/inspection request failed. */
  failedCandidates: number;
}

/**
 * One sourcing cycle: pull candidates from every source, dedup by normalized
 * domain against the Radar queue (any status) and the partner registry, and
 * create at most `maxNewPerCycle` new candidates through the regular Radar
 * create path (idempotency key `sourcing:<domain>`), immediately requesting
 * an inspection so evidence and score appear without manual action.
 */
export class RadarSourcingService {
  constructor(
    private readonly sources: CandidateSource[],
    private readonly radar: RadarPort,
    private readonly store: SourcingDedupStore,
    private readonly maxNewPerCycle: number = 50,
    /**
     * Wraps radar mutations into the system-actor execution context.
     * The postgres Radar service requires an actor; the worker passes
     * {@link createSystemContextRunner} here.
     */
    private readonly runAsSystem: <T>(action: () => Promise<T>) => Promise<T> = (action) =>
      action(),
  ) {
    if (!Number.isInteger(maxNewPerCycle) || maxNewPerCycle < 1) {
      throw new RangeError("maxNewPerCycle must be a positive integer");
    }
  }

  async runCycle(): Promise<SourcingCycleResult> {
    const result: SourcingCycleResult = {
      fetched: 0,
      created: 0,
      skippedDuplicates: 0,
      skippedInvalid: 0,
      failedSources: 0,
      failedCandidates: 0,
    };
    const seenThisCycle = new Set<string>();
    for (const source of this.sources) {
      if (result.created >= this.maxNewPerCycle) break;
      let candidates;
      try {
        candidates = await source.fetchCandidates();
      } catch (error) {
        result.failedSources += 1;
        console.error(
          JSON.stringify({
            event: "radar-sourcing.source-failed",
            source: source.id,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      result.fetched += candidates.length;
      for (const candidate of candidates) {
        if (result.created >= this.maxNewPerCycle) break;
        const host = normalizeCandidateHost(candidate.url);
        if (!host) {
          result.skippedInvalid += 1;
          continue;
        }
        if (seenThisCycle.has(host)) {
          result.skippedDuplicates += 1;
          continue;
        }
        seenThisCycle.add(host);
        if (await this.store.isKnownDomain(host)) {
          result.skippedDuplicates += 1;
          continue;
        }
        try {
          await this.createCandidate(source.id, host, candidate.siteName, candidate.url);
          result.created += 1;
          console.log(
            JSON.stringify({
              event: "radar-sourcing.candidate-created",
              source: source.id,
              host,
              note: candidate.note ?? null,
            }),
          );
        } catch (error) {
          result.failedCandidates += 1;
          console.error(
            JSON.stringify({
              event: "radar-sourcing.candidate-failed",
              source: source.id,
              host,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }
    return result;
  }

  private async createCandidate(sourceId: string, host: string, siteName: string, url: string) {
    await this.runAsSystem(async () => {
      const created = await this.radar.create(
        { name: siteName, url, source: RADAR_SOURCE_AUTO },
        `sourcing:${host}`,
      );
      await this.radar.requestInspection(created.id, `sourcing:${host}`);
    });
  }
}
