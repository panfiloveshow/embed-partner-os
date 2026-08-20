ALTER TABLE "contact"
  ADD COLUMN "merged_into_id" UUID,
  ADD COLUMN "merged_at" TIMESTAMPTZ(6),
  ADD COLUMN "merge_reason" TEXT;

ALTER TABLE "contact"
  ADD CONSTRAINT "contact_merged_into_not_self"
  CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");

CREATE INDEX "contact_merged_into_id_idx" ON "contact"("merged_into_id");

ALTER TABLE "contact"
  ADD CONSTRAINT "contact_merged_into_id_fkey"
  FOREIGN KEY ("merged_into_id") REFERENCES "contact"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
