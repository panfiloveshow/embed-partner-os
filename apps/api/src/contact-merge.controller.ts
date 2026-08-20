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
  Query,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type {
  ContactRegistryItem,
  ContactRegistryPayload,
  MergeContactResult,
} from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { CONTACT_PORT, type ContactPort } from "./contact.port.js";
import { RequirePermission } from "./auth/access-control.js";

@ApiTags("contacts")
@Controller("contacts")
export class ContactMergeController {
  constructor(@Inject(CONTACT_PORT) private readonly contacts: ContactPort) {}

  @Get()
  @RequirePermission("contacts.view")
  @ApiOperation({ summary: "Получить реестр контактов с поиском и фильтрами" })
  @ApiResponse({ status: 200, description: "Контакты, связи с организациями и возможные дубли" })
  async listContacts(
    @Query("search") search?: string,
    @Query("status") status?: string,
    @Query("organizationId") organizationId?: string,
    @Query("duplicatesOnly") duplicatesOnly?: string,
  ): Promise<ContactRegistryPayload> {
    return this.contacts.listContacts({
      ...(search?.trim() ? { search: search.trim() } : {}),
      ...(status?.trim() ? { status: status.trim() } : {}),
      ...(organizationId?.trim() ? { organizationId: organizationId.trim() } : {}),
      duplicatesOnly: duplicatesOnly === "true",
    });
  }

  @Patch(":contactId")
  @RequirePermission("contacts.write")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Обновить профиль контакта и его роль в организации" })
  @ApiParam({ name: "contactId" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 200, description: "Обновлённый контакт" })
  async updateContact(
    @Param("contactId") contactId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<ContactRegistryItem> {
    return this.contacts.updateContact(contactId, body, parseIdempotencyKey(rawIdempotencyKey));
  }

  @Post(":contactId/archive")
  @RequirePermission("contacts.write")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Мягко архивировать контакт" })
  @ApiParam({ name: "contactId" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async archiveContact(
    @Param("contactId") contactId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<ContactRegistryItem> {
    return this.contacts.archiveContact(contactId, body, parseIdempotencyKey(rawIdempotencyKey));
  }

  @Post(":contactId/restore")
  @RequirePermission("contacts.write")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Восстановить контакт из архива" })
  @ApiParam({ name: "contactId" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async restoreContact(
    @Param("contactId") contactId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<ContactRegistryItem> {
    return this.contacts.restoreContact(contactId, body, parseIdempotencyKey(rawIdempotencyKey));
  }

  @Post(":sourceContactId/merge")
  @RequirePermission("contacts.write")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Безопасно объединить контакт-дубликат с каноническим контактом" })
  @ApiParam({ name: "sourceContactId", description: "Контакт-дубликат, который станет архивным" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Уникальный ключ команды; одинаковый payload можно безопасно повторить",
  })
  @ApiResponse({ status: 200, description: "Результат переноса связей и взаимодействий" })
  @ApiResponse({ status: 404, description: "Исходный или целевой контакт не найден" })
  @ApiResponse({ status: 409, description: "Контакт уже объединён или ключ использован повторно" })
  @ApiResponse({ status: 422, description: "Некорректная команда слияния" })
  async mergeContact(
    @Param("sourceContactId") sourceContactId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<MergeContactResult> {
    return this.contacts.mergeContact(
      sourceContactId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }
}
