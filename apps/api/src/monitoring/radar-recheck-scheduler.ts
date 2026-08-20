import type { RadarPort } from "../radar.port.js";

export interface RadarRecheckCandidate {
  id: string;
}

export interface RadarRecheckStore {
  listDue(now: Date, intervalMs: number, limit: number): Promise<RadarRecheckCandidate[]>;
}

export interface RadarRecheckBatchResult {
  selected: number;
  inspected: number;
  failed: number;
}

export class RadarRecheckScheduler {
  constructor(
    private readonly store: RadarRecheckStore,
    private readonly radar: RadarPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async runBatch(intervalMs: number, limit: number): Promise<RadarRecheckBatchResult> {
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000) {
      throw new RangeError("Radar recheck interval must be at least one minute");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Radar recheck batch size must be between 1 and 100");
    }
    const now = this.clock();
    const candidates = await this.store.listDue(now, intervalMs, limit);
    let inspected = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await this.radar.inspect(candidate.id, radarRecheckKey(candidate.id, now, intervalMs));
        inspected += 1;
      } catch {
        failed += 1;
      }
    }
    return { selected: candidates.length, inspected, failed };
  }
}

export function radarRecheckKey(candidateId: string, now: Date, intervalMs: number) {
  return `radar-recheck:${candidateId}:${Math.floor(now.getTime() / intervalMs)}`;
}
