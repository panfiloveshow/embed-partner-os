ALTER TABLE "placement"
  ADD COLUMN "monitor_locked_at" TIMESTAMPTZ(6),
  ADD COLUMN "monitor_locked_by" TEXT,
  ADD COLUMN "monitor_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "monitor_job_key" VARCHAR(200),
  ADD COLUMN "monitor_last_error" VARCHAR(2000),
  ADD COLUMN "monitor_dead_at" TIMESTAMPTZ(6);

ALTER TABLE "placement"
  ADD CONSTRAINT "placement_monitor_lock_pair_check"
  CHECK (
    ("monitor_locked_at" IS NULL AND "monitor_locked_by" IS NULL)
    OR ("monitor_locked_at" IS NOT NULL AND "monitor_locked_by" IS NOT NULL)
  ),
  ADD CONSTRAINT "placement_monitor_attempts_nonnegative_check"
  CHECK ("monitor_attempts" >= 0),
  ADD CONSTRAINT "placement_monitor_job_key_check"
  CHECK (
    "monitor_job_key" IS NULL
    OR "monitor_job_key" ~ '^[A-Za-z0-9._:-]{8,200}$'
  );

CREATE INDEX "placement_monitor_due_idx"
  ON "placement" (
    "business_status",
    "archived_at",
    "monitor_dead_at",
    "next_check_at"
  );

CREATE INDEX "placement_monitor_locked_at_idx"
  ON "placement" ("monitor_locked_at");
