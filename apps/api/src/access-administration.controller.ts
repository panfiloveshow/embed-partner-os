import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { AccessAdministrationPayload, AccessUserView } from "@embed-os/contracts";
import { AccessAdministrationService } from "./access-administration.service.js";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { RequirePermission, type ActorRequest } from "./auth/access-control.js";

@ApiTags("settings")
@Controller("settings/access")
@RequirePermission("system.admin")
export class AccessAdministrationController {
  constructor(
    @Inject(AccessAdministrationService)
    private readonly access: AccessAdministrationService,
  ) {}

  @Get("users")
  @ApiOperation({ summary: "Получить пользователей, роли и разрешения" })
  @ApiResponse({ status: 200, description: "Матрица доступа" })
  list(@Req() request: ActorRequest): Promise<AccessAdministrationPayload> {
    return this.access.list(request.actor!.userId);
  }

  @Post("users")
  @ApiOperation({ summary: "Зарегистрировать корпоративного пользователя" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 201, description: "Пользователь зарегистрирован" })
  create(
    @Req() request: ActorRequest,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<AccessUserView> {
    return this.access.create(
      request.actor!.userId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }

  @Patch("users/:userId")
  @ApiOperation({ summary: "Изменить роль, разрешения или статус пользователя" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 200, description: "Обновлённый доступ пользователя" })
  update(
    @Req() request: ActorRequest,
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<AccessUserView> {
    return this.access.update(
      request.actor!.userId,
      userId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }
}
