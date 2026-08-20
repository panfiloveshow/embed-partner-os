import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../app.module.js";
import { ActorExecutionContext } from "../auth/actor-execution-context.js";
import { RADAR_INSPECTOR } from "../monitoring/radar-page-inspector.js";
import { PersistenceActorService } from "../persistence/persistence-actor.service.js";
import { PrismaService } from "../persistence/prisma.service.js";
import { RADAR_PORT, type RadarPort } from "../radar.port.js";
import { RadarSourcingService } from "./radar-sourcing.service.js";
import { SeedListCandidateSource } from "./seed-list.source.js";
import { PrismaSourcingStore } from "./sourcing-store.js";
import { createSystemContextRunner } from "./system-actor-context.js";

const PARTNER_HOST = "sourcing-partner-it.ru";
const KNOWN_CANDIDATE_HOST = "sourcing-known-it.ru";
const FRESH_HOST = "sourcing-fresh-it.ru";

/**
 * Postgres-only sourcing cycle contract. Runs inside `npm run test:pg`
 * (the sourcing worker itself requires PERSISTENCE_MODE=postgres).
 */
describe.runIf(process.env.PERSISTENCE_MODE === "postgres")(
  "Radar sourcing cycle (postgres)",
  () => {
    let moduleRef: TestingModule;
    let prisma: PrismaService;
    let sourcing: RadarSourcingService;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(RADAR_INSPECTOR)
        .useValue({
          inspect: async () => {
            throw new Error("sourcing must not inspect synchronously");
          },
        })
        .compile();
      prisma = moduleRef.get(PrismaService);
      const radar = moduleRef.get<RadarPort>(RADAR_PORT);
      const actors = moduleRef.get(PersistenceActorService);
      const context = moduleRef.get(ActorExecutionContext);
      const runAsSystem = createSystemContextRunner(actors, context);

      // Fixture 1: an active partner organization already owns PARTNER_HOST.
      const system = await actors.systemActor();
      await prisma.organization.create({
        data: {
          id: randomUUID(),
          name: "Действующий партнёр (sourcing IT)",
          ownerId: system.id,
          domains: {
            create: {
              id: randomUUID(),
              hostNormalized: PARTNER_HOST,
              isPrimary: true,
              source: "sourcing-it-fixture",
            },
          },
        },
      });
      // Fixture 2: KNOWN_CANDIDATE_HOST is already in the Radar queue.
      await runAsSystem(async () => {
        await radar.create(
          {
            name: "Известный кандидат (sourcing IT)",
            url: `https://${KNOWN_CANDIDATE_HOST}/`,
            source: "Ручной поиск",
          },
          `sourcing-it-fixture:${KNOWN_CANDIDATE_HOST}`,
        );
      });

      const store = new PrismaSourcingStore(prisma);
      const seedSource = new SeedListCandidateSource({
        RADAR_SOURCING_SEED_URLS: `${PARTNER_HOST}, https://${KNOWN_CANDIDATE_HOST}/, ${FRESH_HOST}`,
      });
      sourcing = new RadarSourcingService([seedSource], radar, store, 50, runAsSystem);
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    it("creates exactly one auto candidate with a requested inspection, then none", async () => {
      const first = await sourcing.runCycle();
      expect(first).toMatchObject({
        fetched: 3,
        created: 1,
        skippedDuplicates: 2,
        skippedInvalid: 0,
        failedSources: 0,
        failedCandidates: 0,
      });

      const created = await prisma.radarCandidate.findFirst({
        where: { hostNormalized: FRESH_HOST },
      });
      expect(created).not.toBeNull();
      expect(created?.source).toBe("auto");
      expect(created?.status).toBe("NEW");
      // requestInspection ran: the recheck worker will pick the candidate up.
      expect(created?.inspectionRequestedAt).not.toBeNull();
      expect(created?.duplicateOrganizationId).toBeNull();
      expect(created?.duplicateCandidateId).toBeNull();

      // The partner and the existing candidate were skipped without new rows.
      const partnerCandidates = await prisma.radarCandidate.count({
        where: { hostNormalized: PARTNER_HOST },
      });
      expect(partnerCandidates).toBe(0);
      const knownCandidates = await prisma.radarCandidate.count({
        where: { hostNormalized: KNOWN_CANDIDATE_HOST },
      });
      expect(knownCandidates).toBe(1);

      // The audit/outbox contour recorded the system-actor creation.
      const outbox = await prisma.outboxEvent.findFirst({
        where: { eventType: "radar.candidate-created", aggregateId: created!.id },
      });
      expect(outbox).not.toBeNull();

      const second = await sourcing.runCycle();
      expect(second).toMatchObject({ created: 0, skippedDuplicates: 3 });
      expect(await prisma.radarCandidate.count({ where: { hostNormalized: FRESH_HOST } })).toBe(1);
    });
  },
);
