ALTER TABLE "user_account"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "user_account"
  ADD CONSTRAINT "user_account_version_positive" CHECK ("version" > 0);
