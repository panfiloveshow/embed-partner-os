import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Patch,
  Req,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { SlaSettingsPayload } from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { RequirePermission, type ActorRequest } from "./auth/access-control.js";
import { SLA_SETTINGS_PORT, type SlaSettingsPort } from "./sla-settings.port.js";

@ApiTags("settings")
@Controller("settings/sla")
@RequirePermission("system.admin")
export class SlaSettingsController {
  constructor(@Inject(SLA_SETTINGS_PORT) private readonly settings: SlaSettingsPort) {}

  @Get()
  @ApiOperation({ summary: "Получить опубликованные пороги SLA стадий" })
  @ApiResponse({ status: 200, description: "Текущая версия настроек SLA" })
  get(): Promise<SlaSettingsPayload> {
    return this.settings.get();
  }

  @Patch()
  @ApiOperation({ summary: "Опубликовать новую версию настроек SLA" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 200, description: "Новая опубликованная версия" })
  update(
    @Req() request: ActorRequest,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<SlaSettingsPayload> {
    return this.settings.update(
      request.actor!.userId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }
}
