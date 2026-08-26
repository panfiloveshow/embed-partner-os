import type { SenderProfilePayload } from "@embed-os/contracts";

/** Токен DI для порта профиля отправителя. */
export const SENDER_PROFILE_PORT = Symbol("SENDER_PROFILE_PORT");

/**
 * Порт профиля отправителя: имя, email и Telegram менеджера для подписи
 * в черновиках первого касания. Хранится по одному на пользователя.
 */
export interface SenderProfilePort {
  get(actorId: string): Promise<SenderProfilePayload>;
  upsert(actorId: string, profile: SenderProfilePayload): Promise<SenderProfilePayload>;
}
