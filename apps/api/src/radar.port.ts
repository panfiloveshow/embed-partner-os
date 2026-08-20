import type { RadarCandidate, RadarImportResult, RadarPayload } from "@embed-os/contracts";
import type { OrganizationImportFile } from "./application/organization-import.js";

export const RADAR_PORT = Symbol("RADAR_PORT");

export interface RadarPort {
  list(): RadarPayload | Promise<RadarPayload>;
  create(input: unknown, idempotencyKey: string): RadarCandidate | Promise<RadarCandidate>;
  import(file: OrganizationImportFile, idempotencyKey: string): Promise<RadarImportResult>;
  /**
   * Marks the candidate for asynchronous inspection and returns its current
   * state with `inspectionPending: true`. The inspection itself runs in the
   * background (in-memory mode) or in the radar recheck worker (postgres).
   */
  requestInspection(candidateId: string, idempotencyKey: string): Promise<RadarCandidate>;
  /** Executes an inspection right now. Used by background processing. */
  inspect(candidateId: string, idempotencyKey: string): Promise<RadarCandidate>;
  /**
   * Runs every requested-but-unfinished inspection. Returns processing
   * counters. Called by the radar recheck worker (postgres) and by tests.
   */
  processRequestedInspections(limit?: number): Promise<{ processed: number; failed: number }>;
  decide(
    candidateId: string,
    input: unknown,
    idempotencyKey: string,
  ): RadarCandidate | Promise<RadarCandidate>;
  adjustScore(
    candidateId: string,
    input: unknown,
    idempotencyKey: string,
  ): RadarCandidate | Promise<RadarCandidate>;
}
