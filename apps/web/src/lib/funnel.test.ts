import { describe, expect, it } from "vitest";
import type { FunnelOpportunity } from "@embed-os/contracts";
import { filterFunnel, summarizeFunnel } from "./funnel.js";

const opportunities: FunnelOpportunity[] = [
  opportunity("opp-1", "Медиа Новости", "S7", ["overdue", "technical-risk"]),
  opportunity("opp-2", "Спорт Онлайн", "S4", ["missing-next-action"]),
];

describe("funnel selectors", () => {
  it("combines search, stage, owner and risk filters", () => {
    expect(filterFunnel(opportunities, {
      query: "медиа",
      stageCode: "S7",
      ownerId: "user-1",
      risk: "technical-risk",
    }).map(({ id }) => id)).toEqual(["opp-1"]);
  });

  it("summarizes operational risks", () => {
    expect(summarizeFunnel(opportunities)).toEqual({
      active: 2,
      overdue: 1,
      missingNextAction: 1,
      technicalRisk: 1,
    });
  });
});

function opportunity(
  id: string,
  organizationName: string,
  stageCode: FunnelOpportunity["stageCode"],
  riskFlags: FunnelOpportunity["riskFlags"],
): FunnelOpportunity {
  return {
    id,
    version: 1,
    processVersion: 1,
    organizationId: `org-${id}`,
    organizationName,
    domain: `${id}.ru`,
    type: "EMBED",
    stageCode,
    stageLabel: stageCode,
    status: "ACTIVE",
    partnerScore: 80,
    owner: { id: "user-1", name: "Анна" },
    nextAction: null,
    lastInteractionAt: null,
    stageAgeDays: null,
    riskFlags,
  };
}
