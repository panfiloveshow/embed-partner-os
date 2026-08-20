CREATE TABLE "contact" (
  "id" UUID NOT NULL,
  "full_name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "messenger" TEXT,
  "source" TEXT NOT NULL,
  "verified_at" TIMESTAMPTZ(6),
  "restrictions" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "contact_organization" (
  "id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "department" TEXT,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "valid_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_to" TIMESTAMPTZ(6),
  CONSTRAINT "contact_organization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contact_organization_validity" CHECK (
    "valid_to" IS NULL OR "valid_to" >= "valid_from"
  )
);

ALTER TABLE "interaction" ADD COLUMN "contact_id" UUID;

CREATE INDEX "contact_full_name_idx" ON "contact"("full_name");
CREATE INDEX "contact_email_idx" ON "contact"("email");
CREATE INDEX "contact_organization_contact_id_valid_to_idx"
  ON "contact_organization"("contact_id", "valid_to");
CREATE INDEX "contact_organization_organization_id_valid_to_is_primary_idx"
  ON "contact_organization"("organization_id", "valid_to", "is_primary");
CREATE UNIQUE INDEX "contact_organization_active_link_unique"
  ON "contact_organization"("contact_id", "organization_id")
  WHERE "valid_to" IS NULL;
CREATE INDEX "interaction_contact_id_occurred_at_idx"
  ON "interaction"("contact_id", "occurred_at");

ALTER TABLE "contact_organization"
  ADD CONSTRAINT "contact_organization_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contact"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contact_organization"
  ADD CONSTRAINT "contact_organization_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "interaction"
  ADD CONSTRAINT "interaction_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contact"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
