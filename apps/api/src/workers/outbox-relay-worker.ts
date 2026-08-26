import { hostname } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { OutboxRelayService } from "../outbox/outbox-relay.service.js";
import { HttpOutboxPublisher } from "../outbox/http-publisher.js";
import { PrismaOutboxRelayStore } from "../outbox/prisma-outbox-relay.store.js";

/**
 * Непрерывный релей transactional outbox: публикует все накопленные события
 * через HTTP-транспорт (HMAC-подпись + Idempotency-Key на каждое событие).
 * Это недостающее звено до подключения корпоративного брокера: события
 * больше не «копятся в базе», а доставляются подписчику.
 *
 * Обязательные переменные: OUTBOX_PUBLISH_URL, OUTBOX_PUBLISH_SECRET (>=32).
 */

async function bootstrap() {
  requirePostgresMode();
  const prisma = new PrismaClient();
  const abort = shutdownController();
  const pollMs = integerSetting("OUTBOX_RELAY_POLL_MS", 5_000, 100, 60 * 60_000);
  const batchSize = integerSetting("OUTBOX_RELAY_BATCH_SIZE", 50, 1, 1_000);
  const publisher = new HttpOutboxPublisher({
    url: requiredSetting("OUTBOX_PUBLISH_URL"),
    secret: requiredSetting("OUTBOX_PUBLISH_SECRET"),
    timeoutMs: integerSetting("OUTBOX_RELAY_TIMEOUT_MS", 10_000, 100, 60_000),
  });
  const workerId =
    process.env.OUTBOX_WORKER_ID?.trim() || `${hostname()}:${process.pid}:outbox-relay`;
  const relay = new OutboxRelayService(
    new PrismaOutboxRelayStore(prisma),
    publisher,
    workerId,
    () => new Date(),
    60_000,
    1_000,
    5 * 60_000,
  );

  try {
    do {
      const result = await relay.runBatch(batchSize);
      if (result.claimed > 0) {
        console.log(JSON.stringify({ event: "outbox-relay.batch", workerId, ...result }));
      }
      if (process.env.OUTBOX_RELAY_RUN_ONCE === "1") break;
      await wait(pollMs, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    await prisma.$disconnect();
  }
}

function requirePostgresMode() {
  if (process.env.PERSISTENCE_MODE !== "postgres") {
    throw new Error("Outbox relay worker requires PERSISTENCE_MODE=postgres");
  }
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
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
