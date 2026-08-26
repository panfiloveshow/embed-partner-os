import { BadRequestException, Injectable } from "@nestjs/common";
import { parseSenderProfileInput } from "@embed-os/domain";
import type { SenderProfilePayload } from "@embed-os/contracts";
import { SENDER_PROFILE_PORT, type SenderProfilePort } from "./sender-profile.port.js";

/**
 * In-memory профиль отправителя на пользователя. Достаточно для dev-режима
 * и тестов; PostgreSQL-режим использует PostgresSenderProfileService.
 */
@Injectable()
export class SenderProfileService implements SenderProfilePort {
  private readonly profiles = new Map<string, SenderProfilePayload>();

  async get(actorId: string): Promise<SenderProfilePayload> {
    return this.profiles.get(actorId) ?? { fullName: null, email: null, telegram: null };
  }

  async upsert(actorId: string, input: unknown): Promise<SenderProfilePayload> {
    const parsed = parseSenderProfileInput(input);
    if (!parsed.ok) throw new BadRequestException({
      statusCode: 400,
      message: parsed.error,
      error: "Bad Request",
    });
    this.profiles.set(actorId, parsed.value);
    return parsed.value;
  }
}

export { SENDER_PROFILE_PORT };
