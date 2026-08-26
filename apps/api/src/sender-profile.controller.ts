import { Body, Controller, Get, Inject, Put, Req } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { SenderProfilePayload } from "@embed-os/contracts";
import { parseSenderProfileInput } from "@embed-os/domain";
import { BadRequestException } from "@nestjs/common";
import type { ActorRequest } from "./auth/access-control.js";
import { SENDER_PROFILE_PORT, type SenderProfilePort } from "./sender-profile.port.js";

@ApiTags("settings")
@Controller("settings/sender-profile")
export class SenderProfileController {
  constructor(@Inject(SENDER_PROFILE_PORT) private readonly profiles: SenderProfilePort) {}

  @Get()
  @ApiOperation({ summary: "Профиль отправителя текущего менеджера" })
  @ApiResponse({ status: 200, description: "Профиль (пустые поля = не заполнено)" })
  get(@Req() request: ActorRequest): Promise<SenderProfilePayload> {
    return this.profiles.get(request.actor!.userId);
  }

  @Put()
  @ApiOperation({ summary: "Сохранить профиль отправителя (имя, email, Telegram)" })
  @ApiResponse({ status: 200, description: "Сохранённый профиль" })
  async upsert(@Req() request: ActorRequest, @Body() body: unknown): Promise<SenderProfilePayload> {
    const parsed = parseSenderProfileInput(body);
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    return this.profiles.upsert(request.actor!.userId, parsed.value);
  }
}
