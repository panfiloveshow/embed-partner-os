ALTER TABLE "opportunity"
  ADD COLUMN "technical_risk" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "placement" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "opportunity_id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "page_url" VARCHAR(2000) NOT NULL,
  "url_pattern" VARCHAR(500) NOT NULL,
  "embed_type" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "business_status" TEXT NOT NULL,
  "health_status" TEXT NOT NULL DEFAULT 'unchecked',
  "launched_at" TIMESTAMPTZ(6),
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "first_failure_at" TIMESTAMPTZ(6),
  "last_success_at" TIMESTAMPTZ(6),
  "last_check_at" TIMESTAMPTZ(6),
  "next_check_at" TIMESTAMPTZ(6),
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "placement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "placement_business_status_valid" CHECK (
    "business_status" IN ('planned', 'active', 'paused', 'ended')
  ),
  CONSTRAINT "placement_health_status_valid" CHECK (
    "health_status" IN ('unchecked', 'healthy', 'degraded', 'failed', 'awaiting_fix', 'disabled', 'exception')
  ),
  CONSTRAINT "placement_embed_type_valid" CHECK ("embed_type" IN ('video', 'live', 'playlist')),
  CONSTRAINT "placement_environment_valid" CHECK ("environment" IN ('production', 'staging', 'test')),
  CONSTRAINT "placement_failures_non_negative" CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "placement_active_has_launch" CHECK (
    "business_status" <> 'active' OR "launched_at" IS NOT NULL
  )
);

CREATE TABLE "health_check" (
  "id" UUID NOT NULL,
  "placement_id" UUID NOT NULL,
  "checked_at" TIMESTAMPTZ(6) NOT NULL,
  "result" TEXT NOT NULL,
  "page_http_status" INTEGER,
  "embed_http_status" INTEGER,
  "player_found" BOOLEAN NOT NULL,
  "embed_url" VARCHAR(2000),
  "evidence_uri" TEXT,
  "error_code" TEXT,
  "duration_ms" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "details_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "health_check_pkey" PRIMARY KEY ("id", "checked_at"),
  CONSTRAINT "health_check_result_valid" CHECK (
    "result" IN ('healthy', 'degraded', 'failed', 'blocked', 'unknown')
  ),
  CONSTRAINT "health_check_source_valid" CHECK ("source" IN ('manual', 'schedule')),
  CONSTRAINT "health_check_duration_non_negative" CHECK ("duration_ms" >= 0)
) PARTITION BY RANGE ("checked_at");

CREATE TABLE "health_check_2026_08" PARTITION OF "health_check"
  FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z');
CREATE TABLE "health_check_2026_09" PARTITION OF "health_check"
  FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z');
CREATE TABLE "health_check_default" PARTITION OF "health_check" DEFAULT;

CREATE TABLE "alert" (
  "id" UUID NOT NULL,
  "placement_id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "technical_task_id" UUID,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "first_failure_at" TIMESTAMPTZ(6) NOT NULL,
  "opened_at" TIMESTAMPTZ(6) NOT NULL,
  "closed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alert_status_valid" CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "alert_severity_valid" CHECK ("severity" IN ('high', 'medium')),
  CONSTRAINT "alert_close_pair" CHECK (
    ("status" = 'open' AND "closed_at" IS NULL) OR
    ("status" = 'closed' AND "closed_at" IS NOT NULL)
  )
);

CREATE INDEX "placement_owner_id_business_status_next_check_at_idx"
  ON "placement"("owner_id", "business_status", "next_check_at");
CREATE INDEX "placement_opportunity_id_business_status_health_status_idx"
  ON "placement"("opportunity_id", "business_status", "health_status");
CREATE INDEX "placement_organization_id_archived_at_idx"
  ON "placement"("organization_id", "archived_at");
CREATE UNIQUE INDEX "placement_active_page_environment_key"
  ON "placement"("opportunity_id", "page_url", "environment")
  WHERE "archived_at" IS NULL;
CREATE INDEX "health_check_placement_id_checked_at_idx"
  ON "health_check"("placement_id", "checked_at");
CREATE INDEX "health_check_result_checked_at_idx"
  ON "health_check"("result", "checked_at");
CREATE UNIQUE INDEX "alert_technical_task_id_key" ON "alert"("technical_task_id");
CREATE UNIQUE INDEX "alert_one_open_per_placement_key"
  ON "alert"("placement_id", "type") WHERE "status" = 'open';
CREATE INDEX "alert_placement_id_status_opened_at_idx"
  ON "alert"("placement_id", "status", "opened_at");
CREATE INDEX "alert_owner_id_status_opened_at_idx"
  ON "alert"("owner_id", "status", "opened_at");

ALTER TABLE "placement" ADD CONSTRAINT "placement_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "placement" ADD CONSTRAINT "placement_opportunity_id_fkey"
  FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "placement" ADD CONSTRAINT "placement_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "health_check" ADD CONSTRAINT "health_check_placement_id_fkey"
  FOREIGN KEY ("placement_id") REFERENCES "placement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alert" ADD CONSTRAINT "alert_placement_id_fkey"
  FOREIGN KEY ("placement_id") REFERENCES "placement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alert" ADD CONSTRAINT "alert_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alert" ADD CONSTRAINT "alert_technical_task_id_fkey"
  FOREIGN KEY ("technical_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER health_check_append_only
  BEFORE UPDATE OR DELETE ON "health_check"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
