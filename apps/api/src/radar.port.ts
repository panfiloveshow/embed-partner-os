import type { RadarCandidate, RadarImportResult, RadarPayload } from "@embed-os/contracts";
import type { OrganizationImportFile } from "./application/organization-import.js";

export const RADAR_PORT = Symbol("RADAR_PORT");

export interface RadarPort {
  list(): RadarPayload | Promise<RadarPayload>;
  create(input: unknown, idempotencyKey: string): RadarCandidate | Promise<RadarCandidate>;
  import(file: OrganizationImportFile, idempotencyKey: string): Promise<RadarImportResult>;
  inspect(candidateId: string, idempotencyKey: string): Promise<RadarCandidate>;
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
