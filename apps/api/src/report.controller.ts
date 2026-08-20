import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { WeeklyReportSnapshot } from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { REPORT_PORT, type ReportPort } from "./report.port.js";
import { RequirePermission } from "./auth/access-control.js";

@ApiTags("reports")
@Controller("reports/weekly")
export class ReportController {
  constructor(@Inject(REPORT_PORT) private readonly reports: ReportPort) {}

  @Post("snapshots")
  @RequirePermission("reports.generate")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Опубликовать неизменяемый недельный снимок отчёта" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Уникальный ключ команды генерации",
  })
  @ApiResponse({ status: 201, description: "Созданный или ранее опубликованный снимок" })
  @ApiResponse({ status: 422, description: "Некорректная неделя, data_as_of или версия формул" })
  async generateWeekly(
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<WeeklyReportSnapshot> {
    return this.reports.generateWeekly(body, parseIdempotencyKey(rawIdempotencyKey));
  }

  @Get("snapshots/latest")
  @RequirePermission("reports.view")
  @ApiOperation({ summary: "Получить последнюю опубликованную ревизию недельного отчёта" })
  @ApiResponse({ status: 200, description: "Последний опубликованный снимок команды" })
  @ApiResponse({ status: 404, description: "Снимки ещё не опубликованы" })
  async getLatestWeekly(): Promise<WeeklyReportSnapshot> {
    return this.reports.getLatestWeekly();
  }
}
