import "reflect-metadata";
import { hostname } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { PlacementMonitorService } from "../monitoring/placement-monitor.service.js";
import { PrismaPlacementMonitorStore } from "../monitoring/prisma-placement-monitor.store.js";
import type { PlacementPort } from "../placement.port.js";
import { PLACEMENT_PORT } from "../placement.port.js";
import { PrismaService } from "../persistence/prisma.service.js";

async function bootstrap() {
  requirePostgresMode();
  const app = await NestFactory.createApplicationContext(AppModule);
  const abort = shutdownController();
  const prisma = app.get(PrismaService);
  const placements = app.get<PlacementPort>(PLACEMENT_PORT);
  const pollMs = integerSetting("PLACEMENT_MONITOR_POLL_MS", 5_000, 100, 60_000);
  const batchSize = integerSetting("PLACEMENT_MONITOR_BATCH_SIZE", 10, 1, 500);
  const leaseMs = integerSetting("PLACEMENT_MONITOR_LEASE_MS", 60_000, 1_000, 15 * 60_000);
  const maxAttempts = integerSetting("PLACEMENT_MONITOR_MAX_ATTEMPTS", 8, 1, 50);
  const workerId =
    process.env.PLACEMENT_MONITOR_WORKER_ID?.trim() ||
    `${hostname()}:${process.pid}:placement-monitor`;
  const monitor = new PlacementMonitorService(
    new PrismaPlacementMonitorStore(prisma),
    placements,
    workerId,
    () => new Date(),
    leaseMs,
    60_000,
    45 * 60_000,
    maxAttempts,
  );

  try {
    do {
      const result = await monitor.runBatch(batchSize);
      if (result.claimed > 0) {
        console.log(JSON.stringify({ event: "placement-monitor.batch", workerId, ...result }));
      }
      if (process.env.PLACEMENT_MONITOR_RUN_ONCE === "1") break;
      await wait(pollMs, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    await app.close();
  }
}

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requirePostgresMode() {
  if (process.env.PERSISTENCE_MODE !== "postgres") {
    throw new Error("Placement monitor worker requires PERSISTENCE_MODE=postgres");
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
