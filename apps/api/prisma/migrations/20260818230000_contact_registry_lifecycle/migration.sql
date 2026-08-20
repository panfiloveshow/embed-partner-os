ALTER TABLE "contact"
  ADD COLUMN "archived_at" TIMESTAMPTZ(6),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "contact"
  ADD CONSTRAINT "contact_version_positive" CHECK ("version" > 0);

CREATE INDEX "contact_archived_at_idx" ON "contact"("archived_at");
