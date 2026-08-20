CREATE TABLE "import_job" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "format" VARCHAR(16) NOT NULL,
  "source_hash" CHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "summary_json" JSONB NOT NULL DEFAULT '{}',
  "warnings_json" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "import_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_job_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "import_job_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "import_row" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "row_no" INTEGER NOT NULL,
  "values_json" JSONB NOT NULL,
  "normalized_domain" TEXT,
  "decision" VARCHAR(24) NOT NULL,
  "resolved_decision" VARCHAR(24),
  "allowed_decisions_json" JSONB NOT NULL DEFAULT '[]',
  "matched_organization_id" UUID,
  "matched_organization_name" TEXT,
  "field_errors_json" JSONB NOT NULL DEFAULT '{}',
  "warnings_json" JSONB NOT NULL DEFAULT '[]',
  "error_code" VARCHAR(64),
  "entity_id" UUID,
  "applied_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_row_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_row_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "import_job_team_id_created_at_idx" ON "import_job"("team_id", "created_at");
CREATE INDEX "import_job_team_id_source_hash_status_idx" ON "import_job"("team_id", "source_hash", "status");
CREATE UNIQUE INDEX "import_row_job_id_row_no_key" ON "import_row"("job_id", "row_no");
CREATE INDEX "import_row_job_id_decision_idx" ON "import_row"("job_id", "decision");
CREATE INDEX "import_row_entity_id_idx" ON "import_row"("entity_id");
