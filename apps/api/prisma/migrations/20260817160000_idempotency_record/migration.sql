CREATE TABLE "idempotency_record" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "operation" TEXT NOT NULL,
  "request_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "response_status" INTEGER,
  "response_json" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idempotency_response_pair" CHECK (
    ("response_status" IS NULL AND "response_json" IS NULL AND "completed_at" IS NULL) OR
    ("response_status" IS NOT NULL AND "response_json" IS NOT NULL AND "completed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "idempotency_record_actor_operation_key"
  ON "idempotency_record"("actor_id", "operation", "request_key");

CREATE INDEX "idempotency_record_expires_at_idx"
  ON "idempotency_record"("expires_at");

ALTER TABLE "idempotency_record"
  ADD CONSTRAINT "idempotency_record_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "user_account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
