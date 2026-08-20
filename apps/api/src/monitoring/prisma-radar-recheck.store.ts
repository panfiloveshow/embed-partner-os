import { Injectable } from "@nestjs/common";
import type { RadarRecheckStore } from "./radar-recheck-scheduler.js";
import { PrismaService } from "../persistence/prisma.service.js";

@Injectable()
export class PrismaRadarRecheckStore implements RadarRecheckStore {
  constructor(private readonly prisma: PrismaService) {}

  async listDue(now: Date, intervalMs: number, limit: number) {
    const checkedSince = new Date(now.getTime() - intervalMs);
    return this.prisma.radarCandidate.findMany({
      where: {
        AND: [
          {
            OR: [{ status: "READY" }, { status: "DEFERRED", deferUntil: { lte: now } }],
          },
          { evidence: { none: { detectedAt: { gte: checkedSince } } } },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });
  }
}
