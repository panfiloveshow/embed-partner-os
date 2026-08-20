import type {
  FunnelPayload,
  OpportunityStageTransitionResult,
} from "@embed-os/contracts";

export const OPPORTUNITY_PORT = Symbol("OPPORTUNITY_PORT");

export interface OpportunityPort {
  list(): Promise<FunnelPayload>;

  transition(
    opportunityId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<OpportunityStageTransitionResult>;
}
