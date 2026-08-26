-- Профиль отправителя первого касания: имя, email и Telegram менеджера.
CREATE TABLE "sender_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "full_name" VARCHAR(120),
    "email" VARCHAR(254),
    "telegram" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sender_profile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sender_profile_actor_id_key" ON "sender_profile"("actor_id");

ALTER TABLE "sender_profile"
  ADD CONSTRAINT "sender_profile_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "user_account"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
