import type { PrismaService } from "../persistence/prisma.service.js";
import type { ExpansionRootStore } from "./link-expansion.source.js";

/**
 * Dedup lookups for the sourcing pipeline. Sourcing is postgres-only (the
 * sourcing worker requires PERSISTENCE_MODE=postgres, like the recheck
 * worker), so the only production implementation is Prisma-backed.
 */
export interface SourcingDedupStore {
  /**
   * `true` when the domain is already tracked: a Radar candidate in ANY
   * status (including rejected/merged) or an active partner organization
   * domain. Sourcing silently skips such domains.
   */
  isKnownDomain(hostNormalized: string): Promise<boolean>;
}

export class PrismaSourcingStore implements SourcingDedupStore, ExpansionRootStore {
  constructor(private readonly prisma: PrismaService) {}

  async isKnownDomain(hostNormalized: string): Promise<boolean> {
    const candidate = await this.prisma.radarCandidate.findFirst({
      where: { hostNormalized },
      select: { id: true },
    });
    if (candidate) return true;
    const domain = await this.prisma.domain.findFirst({
      where: { hostNormalized, archivedAt: null, organization: { archivedAt: null } },
      select: { id: true },
    });
    return domain !== null;
  }

  /**
   * Domains of active partner organizations, newest first. Accepted Radar
   * candidates create an Organization with a verified Domain row, so this
   * covers both accepted candidates and manually registered partners.
   */
  async listExpansionRoots(limit: number): Promise<string[]> {
    const domains = await this.prisma.domain.findMany({
      where: { archivedAt: null, organization: { archivedAt: null } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit * 2,
      select: { hostNormalized: true },
    });
    return [...new Set(domains.map(({ hostNormalized }) => hostNormalized))].slice(0, limit);
  }
}
