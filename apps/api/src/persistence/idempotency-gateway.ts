import { Prisma } from "@prisma/client";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
} from "../application/idempotency.js";

/** Default reservation lifetime: 24 hours. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

export interface IdempotencyReserveInput {
  /** Primary key of the reservation row to insert. */
  recordId: string;
  actorId: string;
  operation: string;
  requestKey: string;
  requestHash: string;
  now: Date;
  /** Defaults to `now + IDEMPOTENCY_TTL_MS`. */
  expiresAt?: Date;
}

export type IdempotencyReserveResult =
  /** The key was free — the reservation row now belongs to this request. */
  | { state: "reserved" }
  /** The insert conflicted, but the winning row is already gone (rare race). */
  | { state: "missing" }
  /** Another request holds the key; `responseJson` is null while it runs. */
  | { state: "existing"; requestHash: string; responseJson: Prisma.JsonValue | null };

/**
 * Reserves an idempotency key inside the caller's transaction.
 *
 * An expired reservation (`expires_at < now`) is treated as free: it is
 * deleted in the same transaction right before the insert, so the key is
 * taken over atomically with respect to the surrounding transaction.
 */
export async function reserveIdempotency(
  transaction: Prisma.TransactionClient,
  input: IdempotencyReserveInput,
): Promise<IdempotencyReserveResult> {
  await transaction.$executeRaw(Prisma.sql`
    DELETE FROM "idempotency_record"
    WHERE "actor_id" = ${input.actorId}::uuid
      AND "operation" = ${input.operation}
      AND "request_key" = ${input.requestKey}
      AND "expires_at" < ${input.now}
  `);
  const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "idempotency_record" (
      "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
    ) VALUES (
      ${input.recordId}::uuid,
      ${input.actorId}::uuid,
      ${input.operation},
      ${input.requestKey},
      ${input.requestHash},
      ${input.now},
      ${input.expiresAt ?? new Date(input.now.getTime() + IDEMPOTENCY_TTL_MS)}
    )
    ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
    RETURNING "id"
  `);
  if (inserted.length > 0) return { state: "reserved" };
  const existing = await transaction.idempotencyRecord.findUnique({
    where: {
      actorId_operation_requestKey: {
        actorId: input.actorId,
        operation: input.operation,
        requestKey: input.requestKey,
      },
    },
  });
  if (!existing) return { state: "missing" };
  return {
    state: "existing",
    requestHash: existing.requestHash,
    responseJson: existing.responseJson,
  };
}

/**
 * Reserves an idempotency key or returns the stored response for a replay.
 *
 * Returns `null` when the reservation was taken (the caller must execute the
 * operation and finish with {@link completeIdempotency}), or the stored
 * `responseJson` when an identical request already completed.
 *
 * Throws {@link IdempotencyConflictError} when the key was used with a
 * different request payload and {@link IdempotencyInProgressError} while the
 * original request is still running.
 */
export async function reserveOrReplay(
  transaction: Prisma.TransactionClient,
  input: IdempotencyReserveInput,
): Promise<Prisma.JsonValue | null> {
  const reservation = await reserveIdempotency(transaction, input);
  if (reservation.state === "reserved") return null;
  if (reservation.state === "missing") throw new IdempotencyInProgressError(input.requestKey);
  if (reservation.requestHash !== input.requestHash) {
    throw new IdempotencyConflictError(input.requestKey);
  }
  if (reservation.responseJson === null) throw new IdempotencyInProgressError(input.requestKey);
  return reservation.responseJson;
}

/**
 * Stores the response on a reservation created earlier in the same
 * transaction. Guards against double completion via the `responseJson IS
 * NULL` predicate.
 */
export async function completeIdempotency(
  transaction: Prisma.TransactionClient,
  input: {
    recordId: string;
    responseStatus: number;
    responseJson: Prisma.InputJsonValue;
    completedAt: Date;
  },
): Promise<void> {
  const completed = await transaction.idempotencyRecord.updateMany({
    where: { id: input.recordId, responseJson: { equals: Prisma.DbNull } },
    data: {
      responseStatus: input.responseStatus,
      responseJson: input.responseJson,
      completedAt: input.completedAt,
    },
  });
  if (completed.count !== 1) {
    throw new Error("Idempotency reservation could not be completed");
  }
}

/**
 * Deletes one batch of expired idempotency records. Returns the number of
 * deleted rows; callers loop while the batch comes back full.
 */
export async function deleteExpiredIdempotencyRecords(
  client: Pick<Prisma.TransactionClient, "$executeRaw">,
  now: Date,
  batchSize = 1_000,
): Promise<number> {
  return client.$executeRaw(Prisma.sql`
    DELETE FROM "idempotency_record"
    WHERE "id" IN (
      SELECT "id" FROM "idempotency_record"
      WHERE "expires_at" < ${now}
      LIMIT ${batchSize}
    )
  `);
}
