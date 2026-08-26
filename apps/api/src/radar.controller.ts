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
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { RadarCandidate, RadarImportResult, RadarPayload } from "@embed-os/contracts";
import {
  singleCandidateWithSenderProfile,
  withSenderProfile,
} from "@embed-os/domain";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { RADAR_PORT, type RadarPort } from "./radar.port.js";
import { SENDER_PROFILE_PORT, type SenderProfilePort } from "./sender-profile.port.js";
import { RequirePermission, type ActorRequest } from "./auth/access-control.js";

@ApiTags("radar")
@Controller("radar/candidates")
export class RadarController {
  constructor(
    @Inject(RADAR_PORT) private readonly radar: RadarPort,
    @Inject(SENDER_PROFILE_PORT) private readonly senderProfiles: SenderProfilePort,
  ) {}

  @Get()
  @RequirePermission("radar.read")
  @ApiOperation({ summary: "Получить очередь кандидатов Радара" })
  async list(@Req() request: ActorRequest): Promise<RadarPayload> {
    const payload = await this.radar.list();
    // Подпись менеджера подставляется при выдаче: обновление профиля
    // сразу отражается во всех черновиках, без перезаписи хранения.
    const profile = await this.senderProfiles.get(request.actor!.userId);
    return withSenderProfile(payload, profile);
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
    @Req() request: ActorRequest,
    @Param("candidateId") candidateId: string,
    @Headers("idempotency-key") rawKey: string | undefined,
  ): Promise<RadarCandidate> {
    return this.radar
      .requestInspection(candidateId, parseIdempotencyKey(rawKey))
      .then(async (candidate) => {
        const profile = await this.senderProfiles.get(request.actor!.userId);
        return singleCandidateWithSenderProfile(candidate, profile);
      });
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
