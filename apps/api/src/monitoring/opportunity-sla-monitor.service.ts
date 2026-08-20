import {
  evaluateOpportunitySla,
  type OpportunitySlaEvaluation,
  type OpportunitySlaIncidentState,
} from "@embed-os/domain";

export interface OpportunitySlaCandidate {
  id: string;
  organizationId: string;
  organizationName: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  teamId: string | null;
  teamName: string | null;
  stageCode: string;
  stageLabel: string;
  status: "ACTIVE" | "WAITING" | "PAUSED" | "CLOSED";
  createdAt: Date;
  lastInteractionAt: Date | null;
  lastStageChangeAt: Date | null;
  thresholdDays: number;
  escalationAfterDays: number;
  activeIncident: OpportunitySlaIncidentState | null;
}

export interface OpportunitySlaMonitorStore {
  listCandidates(input: { now: Date; batchSize: number }): Promise<OpportunitySlaCandidate[]>;
  openIncident(input: {
    candidate: OpportunitySlaCandidate;
    evaluation: OpportunitySlaEvaluation;
    occurredAt: Date;
  }): Promise<boolean>;
  escalateIncident(input: {
    candidate: OpportunitySlaCandidate;
    incidentId: string;
    evaluation: OpportunitySlaEvaluation;
    occurredAt: Date;
  }): Promise<boolean>;
  resolveIncident(input: {
    candidate: OpportunitySlaCandidate;
    incidentId: string;
    occurredAt: Date;
  }): Promise<boolean>;
}

export interface OpportunitySlaBatchResult {
  scanned: number;
  opened: number;
  escalated: number;
  resolved: number;
}

export class OpportunitySlaMonitorService {
  constructor(
    private readonly store: OpportunitySlaMonitorStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async runBatch(batchSize = 200): Promise<OpportunitySlaBatchResult> {
    const now = this.clock();
    const candidates = await this.store.listCandidates({
      now,
      batchSize: normalizeBatchSize(batchSize),
    });
    const result: OpportunitySlaBatchResult = {
      scanned: candidates.length,
      opened: 0,
      escalated: 0,
      resolved: 0,
    };

    for (const candidate of candidates) {
      const evaluation = evaluateOpportunitySla({
        now,
        status: candidate.status,
        createdAt: candidate.createdAt,
        lastInteractionAt: candidate.lastInteractionAt,
        lastStageChangeAt: candidate.lastStageChangeAt,
        thresholdDays: candidate.thresholdDays,
        escalationAfterDays: candidate.escalationAfterDays,
        activeIncident: candidate.activeIncident,
      });
      if (evaluation.action === "open") {
        if (await this.store.openIncident({ candidate, evaluation, occurredAt: now })) {
          result.opened += 1;
        }
      } else if (evaluation.action === "escalate" && candidate.activeIncident) {
        if (
          await this.store.escalateIncident({
            candidate,
            incidentId: candidate.activeIncident.id,
            evaluation,
            occurredAt: now,
          })
        ) {
          result.escalated += 1;
        }
      } else if (evaluation.action === "resolve" && candidate.activeIncident) {
        if (
          await this.store.resolveIncident({
            candidate,
            incidentId: candidate.activeIncident.id,
            occurredAt: now,
          })
        ) {
          result.resolved += 1;
        }
      }
    }
    return result;
  }
}

function normalizeBatchSize(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new RangeError("SLA monitor batch size must be an integer between 1 and 500");
  }
  return value;
}
