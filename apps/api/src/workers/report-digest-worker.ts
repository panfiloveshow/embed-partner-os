import { hostname } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { OutboxRelayService } from "../outbox/outbox-relay.service.js";
import { PrismaOutboxRelayStore } from "../outbox/prisma-outbox-relay.store.js";
import { ReportDigestWebhookPublisher } from "../reporting/report-digest-publisher.js";

const REPORT_EVENT = "report.weekly.published";

async function bootstrap() {
  requirePostgresMode();
  const prisma = new PrismaClient();
  const abort = shutdownController();
  const pollMs = integerSetting("REPORT_DIGEST_POLL_MS", 2_000, 100, 60_000);
  const batchSize = integerSetting("REPORT_DIGEST_BATCH_SIZE", 25, 1, 500);
  const publisher = new ReportDigestWebhookPublisher({
    webhookUrl: requiredSetting("REPORT_DIGEST_WEBHOOK_URL"),
    publicAppUrl: requiredSetting("PUBLIC_APP_URL"),
    recipients: recipients(requiredSetting("REPORT_DIGEST_RECIPIENTS")),
    webhookSecret: requiredSetting("REPORT_DIGEST_WEBHOOK_SECRET"),
    timeoutMs: integerSetting("REPORT_DIGEST_TIMEOUT_MS", 10_000, 100, 60_000),
  });
  const workerId =
    process.env.OUTBOX_WORKER_ID?.trim() || `${hostname()}:${process.pid}:report-digest`;
  const relay = new OutboxRelayService(
    new PrismaOutboxRelayStore(prisma),
    publisher,
    workerId,
    () => new Date(),
    60_000,
    1_000,
    5 * 60_000,
    [REPORT_EVENT],
  );

  try {
    do {
      const result = await relay.runBatch(batchSize);
      if (result.claimed > 0) {
        console.log(JSON.stringify({ event: "report-digest.batch", workerId, ...result }));
      }
      if (process.env.REPORT_DIGEST_RUN_ONCE === "1") break;
      await wait(pollMs, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    await prisma.$disconnect();
  }
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function recipients(raw: string): string[] {
  const values = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (values.length === 0) throw new Error("REPORT_DIGEST_RECIPIENTS is empty");
  return values;
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
    throw new Error("Report digest worker requires PERSISTENCE_MODE=postgres");
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
