import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { ContactOption } from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { CONTACT_PORT, type ContactPort } from "./contact.port.js";
import { RequirePermission } from "./auth/access-control.js";

@ApiTags("contacts")
@Controller("organizations/:organizationId/contacts")
@RequirePermission("contacts.write")
export class ContactController {
  constructor(@Inject(CONTACT_PORT) private readonly contacts: ContactPort) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Создать контакт и связать его с организацией" })
  @ApiParam({ name: "organizationId" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Уникальный ключ команды; одинаковый payload можно безопасно повторить",
  })
  @ApiResponse({ status: 201, description: "Созданный нормализованный контакт" })
  @ApiResponse({ status: 409, description: "Найдены кандидаты-дубликаты" })
  @ApiResponse({ status: 422, description: "Некорректные данные контакта" })
  async createContact(
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<ContactOption> {
    return this.contacts.createContact(
      organizationId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }

  @Post(":contactId/link")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Связать существующий контакт с организацией" })
  @ApiParam({ name: "organizationId" })
  @ApiParam({ name: "contactId" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Уникальный ключ команды; одинаковый payload можно безопасно повторить",
  })
  @ApiResponse({ status: 201, description: "Контакт в контексте организации" })
  @ApiResponse({ status: 404, description: "Организация или контакт не найдены" })
  @ApiResponse({ status: 409, description: "Контакт уже связан с организацией" })
  async linkContact(
    @Param("organizationId") organizationId: string,
    @Param("contactId") contactId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<ContactOption> {
    return this.contacts.linkContact(
      organizationId,
      contactId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }
}
