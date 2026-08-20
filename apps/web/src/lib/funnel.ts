import type {
  FunnelOpportunity,
  OpportunityRiskFlag,
  OpportunityStageCode,
} from "@embed-os/contracts";

export interface FunnelFilters {
  query: string;
  stageCode: "all" | OpportunityStageCode;
  ownerId: "all" | string;
  risk: "all" | OpportunityRiskFlag;
}

export function filterFunnel(
  opportunities: FunnelOpportunity[],
  filters: FunnelFilters,
): FunnelOpportunity[] {
  const query = filters.query.trim().toLocaleLowerCase("ru");
  return opportunities.filter((opportunity) => {
    const matchesQuery = !query || [
      opportunity.organizationName,
      opportunity.domain,
      opportunity.nextAction?.title ?? "",
    ].some((value) => value.toLocaleLowerCase("ru").includes(query));
    const matchesStage = filters.stageCode === "all" ||
      opportunity.stageCode === filters.stageCode;
    const matchesOwner = filters.ownerId === "all" ||
      opportunity.owner.id === filters.ownerId;
    const matchesRisk = filters.risk === "all" ||
      opportunity.riskFlags.includes(filters.risk);
    return matchesQuery && matchesStage && matchesOwner && matchesRisk;
  });
}

export function summarizeFunnel(opportunities: FunnelOpportunity[]) {
  return {
    active: opportunities.filter(({ status }) => status === "ACTIVE").length,
    overdue: opportunities.filter(({ riskFlags }) => riskFlags.includes("overdue")).length,
    missingNextAction: opportunities.filter(({ riskFlags }) =>
      riskFlags.includes("missing-next-action")).length,
    technicalRisk: opportunities.filter(({ riskFlags }) =>
      riskFlags.includes("technical-risk")).length,
  };
}
