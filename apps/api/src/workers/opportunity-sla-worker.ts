import "reflect-metadata";
import { setTimeout as wait } from "node:timers/promises";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { OpportunitySlaMonitorService } from "../monitoring/opportunity-sla-monitor.service.js";
import { PrismaOpportunitySlaMonitorStore } from "../monitoring/prisma-opportunity-sla-monitor.store.js";
import { PrismaService } from "../persistence/prisma.service.js";

async function bootstrap() {
  requirePostgresMode();
  const app = await NestFactory.createApplicationContext(AppModule);
  const abort = shutdownController();
  const monitor = new OpportunitySlaMonitorService(
    new PrismaOpportunitySlaMonitorStore(app.get(PrismaService)),
  );
  const pollMs = integerSetting("SLA_MONITOR_POLL_MS", 60_000, 1_000, 60 * 60_000);
  const batchSize = integerSetting("SLA_MONITOR_BATCH_SIZE", 200, 1, 500);

  try {
    do {
      const result = await monitor.runBatch(batchSize);
      if (result.opened + result.escalated + result.resolved > 0) {
        console.log(JSON.stringify({ event: "opportunity-sla.batch", ...result }));
      }
      if (process.env.SLA_MONITOR_RUN_ONCE === "1") break;
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
    throw new Error("Opportunity SLA worker requires PERSISTENCE_MODE=postgres");
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
