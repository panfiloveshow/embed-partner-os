import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { HealthCheckView, PlacementCheckResult, PlacementView } from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { PLACEMENT_PORT, type PlacementPort } from "./placement.port.js";
import { RequirePermission } from "./auth/access-control.js";

@ApiTags("placements")
@Controller("placements")
export class PlacementController {
  constructor(@Inject(PLACEMENT_PORT) private readonly placements: PlacementPort) {}

  @Get()
  @RequirePermission("placements.read")
  @ApiOperation({ summary: "Получить реестр размещений команды" })
  list(): PlacementView[] | Promise<PlacementView[]> {
    return this.placements.list();
  }

  @Post()
  @RequirePermission("placements.write")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Зарегистрировать размещение RUTUBE" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 201, description: "Размещение зарегистрировано" })
  register(
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): PlacementView | Promise<PlacementView> {
    return this.placements.register(body, parseIdempotencyKey(rawIdempotencyKey));
  }

  @Patch(":placementId")
  @RequirePermission("placements.write")
  @ApiOperation({ summary: "Изменить параметры или бизнес-статус размещения" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 200, description: "Размещение изменено" })
  update(
    @Param("placementId") placementId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): PlacementView | Promise<PlacementView> {
    return this.placements.update(
      placementId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }

  @Post(":placementId/archive")
  @RequirePermission("placements.write")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Мягко архивировать размещение" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 200, description: "Размещение архивировано" })
  archive(
    @Param("placementId") placementId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): PlacementView | Promise<PlacementView> {
    return this.placements.archive(
      placementId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }

  @Post(":placementId/l0-checks")
  @RequirePermission("placements.write")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Выполнить безопасную ручную L0-проверку размещения" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 201, description: "Результат проверки сохранён" })
  runL0Check(
    @Param("placementId") placementId: string,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<PlacementCheckResult> {
    return this.placements.runL0Check(
      placementId,
      parseIdempotencyKey(rawIdempotencyKey),
      "manual",
    );
  }

  @Get(":placementId/checks")
  @RequirePermission("placements.read")
  @ApiOperation({ summary: "Получить историю L0-проверок размещения" })
  listChecks(@Param("placementId") placementId: string): HealthCheckView[] | Promise<HealthCheckView[]> {
    return this.placements.listChecks(placementId);
  }
}
