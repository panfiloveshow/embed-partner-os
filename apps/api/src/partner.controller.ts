import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type {
  PartnerCardPayload,
  PartnerExportAuditView,
  PartnerIntegrationStatus,
  PartnerRegistryPayload,
} from "@embed-os/contracts";
import { PARTNER_PORT, type PartnerPort, type PartnerRegistryQuery } from "./partner.port.js";
import { RequirePermission, type ActorRequest } from "./auth/access-control.js";

@ApiTags("partners")
@Controller("partners")
export class PartnerController {
  constructor(@Inject(PARTNER_PORT) private readonly partners: PartnerPort) {}

  @Get()
  @RequirePermission("partners.read")
  @ApiOperation({ summary: "Получить реестр организаций с фильтрами" })
  @ApiResponse({ status: 200, description: "Организации и доступные значения фильтров" })
  async list(
    @Query("search") search?: string,
    @Query("groupId") groupId?: string,
    @Query("segment") segment?: string,
    @Query("ownerId") ownerId?: string,
    @Query("stageCode") stageCode?: string,
    @Query("scoreMin") scoreMin?: string,
    @Query("scoreMax") scoreMax?: string,
    @Query("integrationStatus") integrationStatus?: string,
    @Query("activeAfter") activeAfter?: string,
  ): Promise<PartnerRegistryPayload> {
    return this.partners.listPartners({
      ...(search?.trim() ? { search: search.trim() } : {}),
      ...(groupId?.trim() ? { groupId: groupId.trim() } : {}),
      ...(segment?.trim() ? { segment: segment.trim() } : {}),
      ...(ownerId?.trim() ? { ownerId: ownerId.trim() } : {}),
      ...(stageCode?.trim() ? { stageCode: stageCode.trim() } : {}),
      ...(finiteNumber(scoreMin) !== undefined ? { scoreMin: finiteNumber(scoreMin) } : {}),
      ...(finiteNumber(scoreMax) !== undefined ? { scoreMax: finiteNumber(scoreMax) } : {}),
      ...(isIntegrationStatus(integrationStatus) ? { integrationStatus } : {}),
      ...(validIsoDate(activeAfter) ? { activeAfter } : {}),
    });
  }

  @Post("exports")
  @RequirePermission("partners.export")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Экспортировать доступный список партнёров в CSV" })
  @ApiResponse({ status: 200, description: "CSV создан, событие записано в аудит" })
  @ApiResponse({ status: 401, description: "Доверенная учётная запись не передана" })
  @ApiResponse({ status: 403, description: "Нет отдельного разрешения partners.export" })
  async export(
    @Req() request: ActorRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.partners.exportPartners(
      exportQuery(body),
      request.actor!.subject,
    );
    response.setHeader("Content-Type", result.contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${result.audit.fileName}"`);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Export-Audit-Id", result.audit.id);
    return result.content;
  }

  @Get("exports/audit")
  @RequirePermission("partners.export.audit")
  @ApiOperation({ summary: "Получить аудит экспортов доступной команды" })
  async exportAudit(
    @Req() request: ActorRequest,
  ): Promise<PartnerExportAuditView[]> {
    return this.partners.listPartnerExportAudit(request.actor!.subject);
  }

  @Get(":organizationId")
  @RequirePermission("partners.read")
  @ApiOperation({ summary: "Получить единую карточку партнёра" })
  @ApiParam({ name: "organizationId" })
  @ApiResponse({ status: 200, description: "Агрегированная карточка организации" })
  @ApiResponse({ status: 404, description: "Организация не найдена" })
  async get(@Param("organizationId") organizationId: string): Promise<PartnerCardPayload> {
    return this.partners.getPartner(organizationId);
  }
}

function finiteNumber(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validIsoDate(value: string | undefined): value is string {
  return Boolean(value && Number.isFinite(new Date(value).getTime()));
}

function isIntegrationStatus(value: string | undefined): value is PartnerIntegrationStatus {
  return value === "not_started" || value === "planned" || value === "active" || value === "issue";
}

function exportQuery(value: unknown): PartnerRegistryQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const search = text(input.search);
  const groupId = text(input.groupId);
  const segment = text(input.segment);
  const ownerId = text(input.ownerId);
  const stageCode = text(input.stageCode);
  const scoreMin = numeric(input.scoreMin);
  const scoreMax = numeric(input.scoreMax);
  const integrationStatus = text(input.integrationStatus);
  const activeAfter = text(input.activeAfter);
  return {
    ...(search ? { search } : {}),
    ...(groupId ? { groupId } : {}),
    ...(segment ? { segment } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(stageCode ? { stageCode } : {}),
    ...(scoreMin !== undefined ? { scoreMin } : {}),
    ...(scoreMax !== undefined ? { scoreMax } : {}),
    ...(isIntegrationStatus(integrationStatus) ? { integrationStatus } : {}),
    ...(validIsoDate(activeAfter) ? { activeAfter } : {}),
  };
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
