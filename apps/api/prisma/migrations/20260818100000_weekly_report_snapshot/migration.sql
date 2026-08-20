CREATE TABLE "report_snapshot" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "generated_by_id" UUID NOT NULL,
  "period_start" TIMESTAMPTZ(6) NOT NULL,
  "period_end" TIMESTAMPTZ(6) NOT NULL,
  "data_as_of" TIMESTAMPTZ(6) NOT NULL,
  "revision" INTEGER NOT NULL,
  "formula_version" VARCHAR(64) NOT NULL,
  "payload_uri" TEXT NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "report_snapshot_period_valid" CHECK ("period_end" > "period_start"),
  CONSTRAINT "report_snapshot_data_as_of_valid" CHECK ("data_as_of" >= "period_end"),
  CONSTRAINT "report_snapshot_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "report_snapshot_checksum_valid" CHECK ("checksum" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "report_snapshot_exact_key"
  ON "report_snapshot"(
    "team_id", "period_start", "period_end", "data_as_of", "formula_version"
  );
CREATE UNIQUE INDEX "report_snapshot_revision_key"
  ON "report_snapshot"("team_id", "period_start", "period_end", "revision");
CREATE INDEX "report_snapshot_team_id_period_start_revision_idx"
  ON "report_snapshot"("team_id", "period_start", "revision");

ALTER TABLE "report_snapshot"
  ADD CONSTRAINT "report_snapshot_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "report_snapshot"
  ADD CONSTRAINT "report_snapshot_generated_by_id_fkey"
  FOREIGN KEY ("generated_by_id") REFERENCES "user_account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER report_snapshot_append_only
  BEFORE UPDATE OR DELETE ON "report_snapshot"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
