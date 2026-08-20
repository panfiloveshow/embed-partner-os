CREATE TABLE "user_permission" (
  "user_id" UUID NOT NULL,
  "permission" VARCHAR(100) NOT NULL,
  "source" VARCHAR(100) NOT NULL,
  "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "user_permission_pkey" PRIMARY KEY ("user_id", "permission")
);

CREATE INDEX "user_permission_permission_revoked_at_idx"
  ON "user_permission"("permission", "revoked_at");

ALTER TABLE "user_permission"
  ADD CONSTRAINT "user_permission_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
