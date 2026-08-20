import "reflect-metadata";
import { setTimeout as wait } from "node:timers/promises";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { PrismaRadarRecheckStore } from "../monitoring/prisma-radar-recheck.store.js";
import { RadarRecheckScheduler } from "../monitoring/radar-recheck-scheduler.js";
import { deleteExpiredIdempotencyRecords } from "../persistence/idempotency-gateway.js";
import { PrismaService } from "../persistence/prisma.service.js";
import { RADAR_PORT, type RadarPort } from "../radar.port.js";

async function bootstrap() {
  requirePostgresMode();
  const app = await NestFactory.createApplicationContext(AppModule);
  const abort = shutdownController();
  const intervalHours = integerSetting("RADAR_RECHECK_INTERVAL_HOURS", 168, 1, 24 * 90);
  const pollMs = integerSetting("RADAR_RECHECK_POLL_MS", 60 * 60_000, 10_000, 24 * 60 * 60_000);
  const batchSize = integerSetting("RADAR_RECHECK_BATCH_SIZE", 25, 1, 100);
  const prisma = app.get(PrismaService);
  const scheduler = new RadarRecheckScheduler(
    new PrismaRadarRecheckStore(prisma),
    app.get<RadarPort>(RADAR_PORT),
  );

  try {
    do {
      const result = await scheduler.runBatch(intervalHours * 60 * 60_000, batchSize);
      if (result.selected > 0) {
        console.log(JSON.stringify({ event: "radar-recheck.batch", ...result }));
      }
      const purged = await purgeExpiredIdempotencyRecords(prisma);
      if (purged > 0) {
        console.log(JSON.stringify({ event: "idempotency.expired-purged", deleted: purged }));
      }
      if (process.env.RADAR_RECHECK_RUN_ONCE === "1") break;
      await wait(pollMs, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    await app.close();
  }
}

const IDEMPOTENCY_PURGE_BATCH_SIZE = 1_000;

/** Deletes expired idempotency reservations in batches of 1000. */
async function purgeExpiredIdempotencyRecords(prisma: PrismaService) {
  let total = 0;
  for (;;) {
    const deleted = await deleteExpiredIdempotencyRecords(
      prisma,
      new Date(),
      IDEMPOTENCY_PURGE_BATCH_SIZE,
    );
    total += deleted;
    if (deleted < IDEMPOTENCY_PURGE_BATCH_SIZE) break;
  }
  return total;
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
    throw new Error("Radar recheck worker requires PERSISTENCE_MODE=postgres");
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
