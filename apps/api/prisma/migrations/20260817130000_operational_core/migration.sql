CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "OpportunityStatus" AS ENUM ('ACTIVE', 'WAITING', 'PAUSED', 'CLOSED');
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

CREATE TABLE "team" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_account" (
  "id" UUID NOT NULL,
  "external_subject" TEXT NOT NULL,
  "team_id" UUID,
  "display_name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "legal_name" TEXT,
  "segment" TEXT,
  "owner_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "organization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_version_positive" CHECK ("version" > 0)
);

CREATE TABLE "domain" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "host_normalized" TEXT NOT NULL,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT NOT NULL,
  "verified_at" TIMESTAMPTZ(6),
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "domain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "process_definition" (
  "id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "schema_json" JSONB NOT NULL,
  "published_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "process_definition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "opportunity" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "process_version" INTEGER NOT NULL,
  "owner_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "stage_code" TEXT NOT NULL,
  "stage_label" TEXT NOT NULL,
  "status" "OpportunityStatus" NOT NULL DEFAULT 'ACTIVE',
  "score" INTEGER NOT NULL DEFAULT 0,
  "next_task_id" UUID,
  "waiting_reason" TEXT,
  "waiting_for" TEXT,
  "review_at" TIMESTAMPTZ(6),
  "close_reason" TEXT,
  "close_comment" TEXT,
  "return_at" TIMESTAMPTZ(6),
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "opportunity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "opportunity_score_range" CHECK ("score" BETWEEN 0 AND 100),
  CONSTRAINT "opportunity_version_positive" CHECK ("version" > 0),
  CONSTRAINT "opportunity_waiting_fields" CHECK (
    "status" <> 'WAITING' OR
    ("waiting_reason" IS NOT NULL AND "waiting_for" IS NOT NULL AND "review_at" IS NOT NULL)
  ),
  CONSTRAINT "opportunity_close_fields" CHECK (
    "status" <> 'CLOSED' OR ("close_reason" IS NOT NULL AND "close_comment" IS NOT NULL)
  )
);

CREATE TABLE "task" (
  "id" UUID NOT NULL,
  "opportunity_id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  "priority_score" INTEGER NOT NULL DEFAULT 0,
  "priority_reasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
  "outcome" TEXT,
  "completed_at" TIMESTAMPTZ(6),
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "task_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_priority_range" CHECK ("priority_score" BETWEEN 0 AND 100),
  CONSTRAINT "task_version_positive" CHECK ("version" > 0),
  CONSTRAINT "task_completed_fields" CHECK (
    "status" <> 'COMPLETED' OR ("outcome" IS NOT NULL AND "completed_at" IS NOT NULL)
  )
);

CREATE TABLE "interaction" (
  "id" UUID NOT NULL,
  "opportunity_id" UUID NOT NULL,
  "task_id" UUID,
  "author_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "summary" VARCHAR(4000) NOT NULL,
  "outcome" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stage_history" (
  "id" UUID NOT NULL,
  "opportunity_id" UUID NOT NULL,
  "from_stage" TEXT NOT NULL,
  "to_stage" TEXT NOT NULL,
  "actor_id" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "stage_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_log" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" UUID NOT NULL,
  "before_json" JSONB,
  "after_json" JSONB,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_event" (
  "id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "aggregate_version" INTEGER NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "published_at" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_event_attempts_non_negative" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "user_account_external_subject_key" ON "user_account"("external_subject");
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account"("email");
CREATE INDEX "user_account_team_id_status_idx" ON "user_account"("team_id", "status");
CREATE INDEX "organization_owner_id_status_idx" ON "organization"("owner_id", "status");
CREATE INDEX "organization_name_idx" ON "organization"("name");
CREATE UNIQUE INDEX "domain_host_active_unique" ON "domain"("host_normalized") WHERE "archived_at" IS NULL;
CREATE INDEX "domain_organization_id_idx" ON "domain"("organization_id");
CREATE INDEX "domain_host_normalized_idx" ON "domain"("host_normalized");
CREATE UNIQUE INDEX "process_definition_version_key" ON "process_definition"("version");
CREATE UNIQUE INDEX "opportunity_next_task_id_key" ON "opportunity"("next_task_id");
CREATE INDEX "opportunity_organization_id_status_idx" ON "opportunity"("organization_id", "status");
CREATE INDEX "opportunity_owner_id_status_stage_code_idx" ON "opportunity"("owner_id", "status", "stage_code");
CREATE INDEX "opportunity_review_at_idx" ON "opportunity"("review_at");
CREATE INDEX "task_owner_id_status_due_at_idx" ON "task"("owner_id", "status", "due_at");
CREATE INDEX "task_opportunity_id_status_due_at_idx" ON "task"("opportunity_id", "status", "due_at");
CREATE INDEX "interaction_opportunity_id_occurred_at_idx" ON "interaction"("opportunity_id", "occurred_at");
CREATE INDEX "stage_history_opportunity_id_occurred_at_idx" ON "stage_history"("opportunity_id", "occurred_at");
CREATE INDEX "audit_log_entity_type_entity_id_occurred_at_idx" ON "audit_log"("entity_type", "entity_id", "occurred_at");
CREATE INDEX "audit_log_actor_id_occurred_at_idx" ON "audit_log"("actor_id", "occurred_at");
CREATE UNIQUE INDEX "outbox_event_aggregate_version_key" ON "outbox_event"("aggregate_type", "aggregate_id", "aggregate_version", "event_type");
CREATE INDEX "outbox_event_unpublished_idx" ON "outbox_event"("published_at", "occurred_at");

ALTER TABLE "user_account" ADD CONSTRAINT "user_account_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "organization" ADD CONSTRAINT "organization_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "domain" ADD CONSTRAINT "domain_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_process_version_fkey" FOREIGN KEY ("process_version") REFERENCES "process_definition"("version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task" ADD CONSTRAINT "task_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task" ADD CONSTRAINT "task_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_next_task_id_fkey" FOREIGN KEY ("next_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION prevent_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER stage_history_append_only
  BEFORE UPDATE OR DELETE ON "stage_history"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

