CREATE TABLE "organization_group" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "organization_group_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_group_version_positive" CHECK ("version" > 0)
);

ALTER TABLE "organization"
  ADD COLUMN "group_id" UUID;

CREATE INDEX "organization_group_team_id_status_name_idx"
  ON "organization_group"("team_id", "status", "name");

CREATE INDEX "organization_group_id_status_idx"
  ON "organization"("group_id", "status");

ALTER TABLE "organization_group"
  ADD CONSTRAINT "organization_group_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "organization"
  ADD CONSTRAINT "organization_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "organization_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
