import { describe, expect, it } from "vitest";
import {
  opportunityScope,
  organizationScope,
  radarCandidateScope,
  taskScope,
  type PersistenceActor,
} from "./persistence-actor.service.js";

const base: PersistenceActor = {
  id: "user-1",
  subject: "corp:user-1",
  displayName: "Иван Петров",
  role: "partner_manager",
  scopeMode: "own",
  teamId: "team-1",
  teamName: "Команда 1",
};

describe("persistence actor scopes", () => {
  it("restricts own and assigned views to the current owner", () => {
    expect(taskScope(base)).toEqual({ ownerId: "user-1" });
    expect(opportunityScope({ ...base, scopeMode: "assigned" })).toEqual({ ownerId: "user-1" });
    expect(radarCandidateScope(base)).toEqual({ createdById: "user-1" });
  });

  it("restricts team views by team and leaves admin all scope unrestricted", () => {
    expect(opportunityScope({ ...base, scopeMode: "team" })).toEqual({
      owner: { teamId: "team-1" },
    });
    const organizationVisibility = organizationScope({ ...base, scopeMode: "team" });
    expect(organizationVisibility.OR).toContainEqual({ owner: { teamId: "team-1" } });
    expect(organizationVisibility.OR).toContainEqual({
      opportunities: { some: { archivedAt: null, owner: { teamId: "team-1" } } },
    });
    expect(taskScope({ ...base, scopeMode: "all" })).toEqual({});
  });
});
