import "reflect-metadata";
import { setTimeout as wait } from "node:timers/promises";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { ActorExecutionContext } from "../auth/actor-execution-context.js";
import { SafeHttpClient } from "../monitoring/safe-http-client.js";
import { PersistenceActorService } from "../persistence/persistence-actor.service.js";
import { PrismaService } from "../persistence/prisma.service.js";
import { RADAR_PORT, type RadarPort } from "../radar.port.js";
import { LinkExpansionCandidateSource } from "../sourcing/link-expansion.source.js";
import { RadarSourcingService } from "../sourcing/radar-sourcing.service.js";
import { SeedListCandidateSource } from "../sourcing/seed-list.source.js";
import { PrismaSourcingStore } from "../sourcing/sourcing-store.js";
import { createSystemContextRunner } from "../sourcing/system-actor-context.js";

async function bootstrap() {
  requirePostgresMode();
  const app = await NestFactory.createApplicationContext(AppModule);
  const abort = shutdownController();
  // Default: one sourcing cycle every 6 hours.
  const pollMs = integerSetting(
    "RADAR_SOURCING_POLL_MS",
    6 * 60 * 60_000,
    10_000,
    7 * 24 * 60 * 60_000,
  );
  const maxNew = integerSetting("RADAR_SOURCING_MAX_NEW", 50, 1, 500);
  const prisma = app.get(PrismaService);
  const radar = app.get<RadarPort>(RADAR_PORT);
  const store = new PrismaSourcingStore(prisma);
  const sourcing = new RadarSourcingService(
    [new SeedListCandidateSource(), new LinkExpansionCandidateSource(store, new SafeHttpClient())],
    radar,
    store,
    maxNew,
    createSystemContextRunner(app.get(PersistenceActorService), app.get(ActorExecutionContext)),
  );
  // Dedup queries the partner registry directly, so sourcing is postgres-only.
  console.log(
    JSON.stringify({ event: "radar-sourcing.start", mode: "postgres-only", pollMs, maxNew }),
  );

  try {
    do {
      const result = await sourcing.runCycle();
      console.log(JSON.stringify({ event: "radar-sourcing.cycle", ...result }));
      if (process.env.RADAR_SOURCING_RUN_ONCE === "1") break;
      await wait(pollMs, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    await app.close();
  }
}

function integerSetting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requirePostgresMode() {
  if (process.env.PERSISTENCE_MODE !== "postgres") {
    throw new Error("Radar sourcing worker requires PERSISTENCE_MODE=postgres");
  }
}

function shutdownController() {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
