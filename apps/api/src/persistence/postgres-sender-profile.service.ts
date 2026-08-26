import { Inject, Injectable } from "@nestjs/common";
import type { SenderProfilePayload } from "@embed-os/contracts";
import { PrismaService } from "./prisma.service.js";
import { SENDER_PROFILE_PORT, type SenderProfilePort } from "../sender-profile.port.js";

@Injectable()
export class PostgresSenderProfileService implements SenderProfilePort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async get(actorId: string): Promise<SenderProfilePayload> {
    const row = await this.prisma.senderProfile.findUnique({ where: { actorId } });
    if (!row) return { fullName: null, email: null, telegram: null };
    return { fullName: row.fullName, email: row.email, telegram: row.telegram };
  }

  async upsert(actorId: string, profile: SenderProfilePayload): Promise<SenderProfilePayload> {
    const row = await this.prisma.senderProfile.upsert({
      where: { actorId },
      create: {
        actorId,
        fullName: profile.fullName,
        email: profile.email,
        telegram: profile.telegram,
      },
      update: {
        fullName: profile.fullName,
        email: profile.email,
        telegram: profile.telegram,
      },
    });
    return { fullName: row.fullName, email: row.email, telegram: row.telegram };
  }
}

export { SENDER_PROFILE_PORT };
