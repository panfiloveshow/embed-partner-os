import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { RadarCandidate, RadarImportResult, RadarPayload } from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { RADAR_PORT, type RadarPort } from "./radar.port.js";
import { RequirePermission } from "./auth/access-control.js";

@ApiTags("radar")
@Controller("radar/candidates")
export class RadarController {
  constructor(@Inject(RADAR_PORT) private readonly radar: RadarPort) {}

  @Get()
  @RequirePermission("radar.read")
  @ApiOperation({ summary: "Получить очередь кандидатов Радара" })
  list(): RadarPayload | Promise<RadarPayload> {
    return this.radar.list();
  }

  @Post()
  @RequirePermission("radar.write")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Добавить домен или URL в Радар" })
  @ApiResponse({ status: 201, description: "Кандидат создан" })
  create(
    @Body() body: unknown,
    @Headers("idempotency-key") rawKey: string | undefined,
  ): RadarCandidate | Promise<RadarCandidate> {
    return this.radar.create(body, parseIdempotencyKey(rawKey));
  }

  @Post("import")
  @RequirePermission("radar.write")
  @UseInterceptors(FileInterceptor("file", { limits: { files: 1, fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes("multipart/form-data")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Добавить кандидатов из CSV или XLSX" })
  import(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Headers("idempotency-key") rawKey: string | undefined,
  ): Promise<RadarImportResult> {
    if (!file) throw new BadRequestException("Добавьте CSV или XLSX в поле file");
    return this.radar.import(
      { fileName: file.originalname, buffer: file.buffer },
      parseIdempotencyKey(rawKey),
    );
  }

  @Post(":candidateId/checks")
  @RequirePermission("radar.write")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Запросить проверку публичной страницы (выполняется асинхронно)" })
  @ApiResponse({
    status: 202,
    description: "Проверка поставлена в очередь; кандидат возвращён с inspectionPending: true",
  })
  inspect(
    @Param("candidateId") candidateId: string,
    @Headers("idempotency-key") rawKey: string | undefined,
  ): Promise<RadarCandidate> {
    return this.radar.requestInspection(candidateId, parseIdempotencyKey(rawKey));
  }

  @Post(":candidateId/decisions")
  @RequirePermission("radar.write")
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Принять, отложить, отклонить или объединить кандидата" })
  decide(
    @Param("candidateId") candidateId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawKey: string | undefined,
  ): RadarCandidate | Promise<RadarCandidate> {
    return this.radar.decide(candidateId, body, parseIdempotencyKey(rawKey));
  }

  @Post(":candidateId/score-adjustments")
  @RequirePermission("radar.write")
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Сохранить ручную корректировку Partner Score" })
  adjustScore(
    @Param("candidateId") candidateId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawKey: string | undefined,
  ): RadarCandidate | Promise<RadarCandidate> {
    return this.radar.adjustScore(candidateId, body, parseIdempotencyKey(rawKey));
  }
}
