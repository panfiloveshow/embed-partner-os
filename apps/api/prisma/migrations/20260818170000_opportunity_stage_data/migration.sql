ALTER TABLE "opportunity"
ADD COLUMN "stage_data" JSONB NOT NULL DEFAULT '{}'::jsonb;
