CREATE TABLE "radar_candidate" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "source" VARCHAR(200) NOT NULL,
  "input_url" VARCHAR(2000) NOT NULL,
  "page_url" VARCHAR(2000) NOT NULL,
  "host_normalized" TEXT NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "features_json" JSONB NOT NULL DEFAULT '{}',
  "score_total" INTEGER NOT NULL,
  "score_automatic_total" INTEGER NOT NULL,
  "score_manual_adjustment" INTEGER NOT NULL DEFAULT 0,
  "score_manual_comment" VARCHAR(1000),
  "score_priority" VARCHAR(16) NOT NULL,
  "score_model_version" VARCHAR(64) NOT NULL,
  "duplicate_organization_id" UUID,
  "duplicate_candidate_id" UUID,
  "defer_until" TIMESTAMPTZ(6),
  "rejection_reason" VARCHAR(1000),
  "rejection_comment" VARCHAR(1000),
  "merged_into_candidate_id" UUID,
  "accepted_organization_id" UUID,
  "accepted_opportunity_id" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "radar_candidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "radar_candidate_score_total_valid" CHECK ("score_total" BETWEEN 0 AND 100),
  CONSTRAINT "radar_candidate_score_automatic_valid" CHECK ("score_automatic_total" BETWEEN 0 AND 100),
  CONSTRAINT "radar_candidate_manual_adjustment_valid" CHECK ("score_manual_adjustment" BETWEEN -40 AND 40),
  CONSTRAINT "radar_candidate_version_positive" CHECK ("version" > 0),
  CONSTRAINT "radar_candidate_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "radar_candidate_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "radar_candidate_duplicate_organization_id_fkey" FOREIGN KEY ("duplicate_organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "radar_candidate_duplicate_candidate_id_fkey" FOREIGN KEY ("duplicate_candidate_id") REFERENCES "radar_candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "radar_candidate_merged_into_candidate_id_fkey" FOREIGN KEY ("merged_into_candidate_id") REFERENCES "radar_candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "radar_candidate_accepted_organization_id_fkey" FOREIGN KEY ("accepted_organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "radar_candidate_accepted_opportunity_id_fkey" FOREIGN KEY ("accepted_opportunity_id") REFERENCES "opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "radar_evidence" (
  "id" UUID NOT NULL,
  "candidate_id" UUID NOT NULL,
  "page_url" VARCHAR(2000) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "player_type" VARCHAR(120),
  "detected_at" TIMESTAMPTZ(6) NOT NULL,
  "method" VARCHAR(24) NOT NULL,
  "confidence" VARCHAR(16) NOT NULL,
  "http_status" INTEGER,
  "player_found" BOOLEAN NOT NULL,
  "embed_url" VARCHAR(2000),
  "error_code" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "radar_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "radar_evidence_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "radar_candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "radar_score_snapshot" (
  "id" UUID NOT NULL,
  "candidate_id" UUID NOT NULL,
  "total" INTEGER NOT NULL,
  "automatic_total" INTEGER NOT NULL,
  "manual_adjustment" INTEGER NOT NULL,
  "manual_comment" VARCHAR(1000),
  "priority" VARCHAR(16) NOT NULL,
  "model_version" VARCHAR(64) NOT NULL,
  "factors_json" JSONB NOT NULL,
  "calculated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "radar_score_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "radar_score_snapshot_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "radar_candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "radar_decision" (
  "id" UUID NOT NULL,
  "candidate_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "decision" VARCHAR(24) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "comment" VARCHAR(1000),
  "defer_until" TIMESTAMPTZ(6),
  "merge_target_id" UUID,
  "decided_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "radar_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "radar_decision_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "radar_candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "radar_decision_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "radar_decision_merge_target_id_fkey" FOREIGN KEY ("merge_target_id") REFERENCES "radar_candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "radar_candidate_team_id_status_score_total_idx" ON "radar_candidate"("team_id", "status", "score_total");
CREATE INDEX "radar_candidate_team_id_host_normalized_status_idx" ON "radar_candidate"("team_id", "host_normalized", "status");
CREATE INDEX "radar_candidate_duplicate_organization_id_idx" ON "radar_candidate"("duplicate_organization_id");
CREATE INDEX "radar_candidate_duplicate_candidate_id_idx" ON "radar_candidate"("duplicate_candidate_id");
CREATE INDEX "radar_candidate_merged_into_candidate_id_idx" ON "radar_candidate"("merged_into_candidate_id");
CREATE INDEX "radar_evidence_candidate_id_detected_at_idx" ON "radar_evidence"("candidate_id", "detected_at");
CREATE INDEX "radar_evidence_status_detected_at_idx" ON "radar_evidence"("status", "detected_at");
CREATE INDEX "radar_score_snapshot_candidate_id_calculated_at_idx" ON "radar_score_snapshot"("candidate_id", "calculated_at");
CREATE INDEX "radar_decision_candidate_id_decided_at_idx" ON "radar_decision"("candidate_id", "decided_at");
CREATE INDEX "radar_decision_actor_id_decided_at_idx" ON "radar_decision"("actor_id", "decided_at");
CREATE INDEX "radar_decision_merge_target_id_idx" ON "radar_decision"("merge_target_id");

CREATE TRIGGER radar_evidence_append_only
  BEFORE UPDATE OR DELETE ON "radar_evidence"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER radar_score_snapshot_append_only
  BEFORE UPDATE OR DELETE ON "radar_score_snapshot"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER radar_decision_append_only
  BEFORE UPDATE OR DELETE ON "radar_decision"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
