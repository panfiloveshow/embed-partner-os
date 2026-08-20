import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { TodayPayload } from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { TODAY_PORT, type TodayPort } from "./today.port.js";
import { RequirePermission } from "./auth/access-control.js";

@ApiTags("today")
@Controller()
export class TodayController {
  constructor(@Inject(TODAY_PORT) private readonly todayService: TodayPort) {}

  @Get("today")
  @RequirePermission("today.read")
  @ApiOperation({ summary: "Персональная приоритетная очередь менеджера" })
  @ApiResponse({ status: 200, description: "Снимок очереди на текущий момент" })
  async getToday(): Promise<TodayPayload> {
    return this.todayService.getToday();
  }

  @Post("tasks/:taskId/complete")
  @RequirePermission("tasks.write")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Зафиксировать взаимодействие, результат и следующее состояние одним действием",
  })
  @ApiParam({ name: "taskId" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Уникальный ключ команды; одинаковый payload можно безопасно повторить",
  })
  @ApiResponse({ status: 200, description: "Обновлённая очередь" })
  @ApiResponse({ status: 400, description: "Idempotency-Key отсутствует или некорректен" })
  @ApiResponse({ status: 409, description: "Ключ уже использован с другим payload" })
  @ApiResponse({
    status: 422,
    description: "Нарушено BR-002/TSK-008 или контакт не связан с организацией",
  })
  async completeTask(
    @Param("taskId") taskId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<TodayPayload> {
    return this.todayService.completeTask(
      taskId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }

  @Post("tasks/:taskId/reschedule")
  @RequirePermission("tasks.write")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Перенести срок задачи с обязательной причиной" })
  @ApiParam({ name: "taskId" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 200, description: "Срок изменён, обновлённая очередь возвращена" })
  @ApiResponse({ status: 422, description: "Не указана причина или новый срок не позже текущего" })
  async rescheduleTask(
    @Param("taskId") taskId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<TodayPayload> {
    return this.todayService.rescheduleTask(
      taskId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }
}
