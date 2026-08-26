import { hostname } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { OutboxRelayService } from "../outbox/outbox-relay.service.js";
import { PrismaOutboxRelayStore } from "../outbox/prisma-outbox-relay.store.js";
import {
  SLA_NOTIFICATION_EVENTS,
  SlaNotificationWebhookPublisher,
} from "../notifications/sla-notification-publisher.js";
import {
  TelegramOutboxPublisher,
  formatSlaEnvelopeText,
} from "../notifications/telegram-publisher.js";
import type { OutboxPublisher } from "../outbox/outbox-relay.service.js";

async function bootstrap() {
  requirePostgresMode();
  const prisma = new PrismaClient();
  const abort = shutdownController();
  const publisher = buildSlaPublisher();
  const workerId =
    process.env.SLA_NOTIFICATION_WORKER_ID?.trim() ||
    `${hostname()}:${process.pid}:sla-notification`;
  const relay = new OutboxRelayService(
    new PrismaOutboxRelayStore(prisma),
    publisher,
    workerId,
    () => new Date(),
    60_000,
    1_000,
    5 * 60_000,
    SLA_NOTIFICATION_EVENTS,
  );
  const pollMs = integerSetting("SLA_NOTIFICATION_POLL_MS", 2_000, 100, 60_000);
  const batchSize = integerSetting("SLA_NOTIFICATION_BATCH_SIZE", 25, 1, 500);

  try {
    do {
      const result = await relay.runBatch(batchSize);
      if (result.claimed > 0) {
        console.log(JSON.stringify({ event: "sla-notification.batch", workerId, ...result }));
      }
      if (process.env.SLA_NOTIFICATION_RUN_ONCE === "1") break;
      await wait(pollMs, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    await prisma.$disconnect();
  }
}

function requiredSetting(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function recipients(raw: string) {
  const values = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (values.length === 0) throw new Error("SLA_ESCALATION_RECIPIENTS is empty");
  return values;
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
    throw new Error("SLA notification worker requires PERSISTENCE_MODE=postgres");
  }
}

/**
 * Выбор канала доставки: SLA_NOTIFICATION_CHANNEL=telegram отправляет
 * сообщения через Telegram Bot API (TELEGRAM_BOT_TOKEN +
 * SLA_NOTIFICATION_TELEGRAM_CHAT_ID); значение по умолчанию — прежний
 * подписанный webhook-шлюз.
 */
function buildSlaPublisher(): OutboxPublisher {
  const timeoutMs = integerSetting("SLA_NOTIFICATION_TIMEOUT_MS", 10_000, 100, 60_000);
  if ((process.env.SLA_NOTIFICATION_CHANNEL ?? "").trim() === "telegram") {
    return new TelegramOutboxPublisher(
      {
        botToken: requiredSetting("TELEGRAM_BOT_TOKEN"),
        chatId: requiredSetting("SLA_NOTIFICATION_TELEGRAM_CHAT_ID"),
        timeoutMs,
      },
      formatSlaEnvelopeText,
    );
  }
  return new SlaNotificationWebhookPublisher({
    webhookUrl: requiredSetting("SLA_NOTIFICATION_WEBHOOK_URL"),
    publicAppUrl: requiredSetting("PUBLIC_APP_URL"),
    escalationRecipients: recipients(requiredSetting("SLA_ESCALATION_RECIPIENTS")),
    webhookSecret: requiredSetting("SLA_NOTIFICATION_WEBHOOK_SECRET"),
    timeoutMs,
  });
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
