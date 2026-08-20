import {
  BadRequestException,
  Body,
  Controller,
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
import type { OrganizationImportJob } from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import {
  ORGANIZATION_IMPORT_PORT,
  type OrganizationImportPort,
} from "./organization-import.port.js";
import { RequirePermission } from "./auth/access-control.js";

interface UploadedOrganizationImport {
  originalname: string;
  buffer: Buffer;
  size: number;
}

@ApiTags("imports")
@Controller("imports/organizations")
@RequirePermission("imports.organizations.write")
export class OrganizationImportController {
  constructor(
    @Inject(ORGANIZATION_IMPORT_PORT) private readonly imports: OrganizationImportPort,
  ) {}

  @Post("preview")
  @UseInterceptors(FileInterceptor("file", { limits: { files: 1, fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Проверить CSV/XLSX и подготовить построчный предпросмотр" })
  @ApiResponse({ status: 201, description: "Предпросмотр импорта подготовлен" })
  preview(@UploadedFile() file: UploadedOrganizationImport | undefined): Promise<OrganizationImportJob> {
    if (!file) throw new BadRequestException("Добавьте CSV или XLSX в поле file");
    return this.imports.preview({ fileName: file.originalname, buffer: file.buffer });
  }

  @Post(":jobId/commit")
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Применить подтверждённый импорт и сохранить протокол" })
  commit(
    @Param("jobId") jobId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<OrganizationImportJob> {
    return this.imports.commit(jobId, body, parseIdempotencyKey(rawIdempotencyKey));
  }

  @Post(":jobId/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Отменить импорт без изменения реестра" })
  cancel(
    @Param("jobId") jobId: string,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<OrganizationImportJob> {
    return this.imports.cancel(jobId, parseIdempotencyKey(rawIdempotencyKey));
  }
}
