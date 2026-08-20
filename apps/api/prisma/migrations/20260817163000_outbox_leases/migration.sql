ALTER TABLE "outbox_event"
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "locked_at" TIMESTAMPTZ(6),
  ADD COLUMN "locked_by" TEXT;

CREATE INDEX "outbox_event_ready_idx"
  ON "outbox_event"("published_at", "next_attempt_at", "occurred_at");

ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_lock_pair" CHECK (
    ("locked_at" IS NULL AND "locked_by" IS NULL) OR
    ("locked_at" IS NOT NULL AND "locked_by" IS NOT NULL)
  );
