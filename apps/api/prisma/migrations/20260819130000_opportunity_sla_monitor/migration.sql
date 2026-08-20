CREATE TABLE "opportunity_sla_incident" (
  "id" UUID NOT NULL,
  "opportunity_id" UUID NOT NULL,
  "task_id" UUID,
  "stage_code" VARCHAR(24) NOT NULL,
  "activity_marker_at" TIMESTAMPTZ(6) NOT NULL,
  "threshold_days" INTEGER NOT NULL,
  "escalation_after_days" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "owner_notified_at" TIMESTAMPTZ(6) NOT NULL,
  "escalated_at" TIMESTAMPTZ(6),
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "opportunity_sla_incident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "opportunity_sla_incident_threshold_positive" CHECK ("threshold_days" BETWEEN 1 AND 365),
  CONSTRAINT "opportunity_sla_incident_escalation_positive" CHECK ("escalation_after_days" BETWEEN 1 AND 365),
  CONSTRAINT "opportunity_sla_incident_status_valid" CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "opportunity_sla_incident_resolution_pair" CHECK (
    ("status" = 'open' AND "resolved_at" IS NULL) OR
    ("status" = 'resolved' AND "resolved_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "opportunity_sla_incident_task_id_key"
  ON "opportunity_sla_incident"("task_id");
CREATE UNIQUE INDEX "opportunity_sla_incident_marker_key"
  ON "opportunity_sla_incident"("opportunity_id", "activity_marker_at");
CREATE INDEX "opportunity_sla_incident_status_owner_notified_at_idx"
  ON "opportunity_sla_incident"("status", "owner_notified_at");
CREATE INDEX "opportunity_sla_incident_opportunity_id_status_created_at_idx"
  ON "opportunity_sla_incident"("opportunity_id", "status", "created_at");

ALTER TABLE "opportunity_sla_incident"
  ADD CONSTRAINT "opportunity_sla_incident_opportunity_id_fkey"
  FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunity_sla_incident"
  ADD CONSTRAINT "opportunity_sla_incident_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
