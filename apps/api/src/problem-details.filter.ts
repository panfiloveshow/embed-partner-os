import { randomUUID } from "node:crypto";
import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import type { ContactCandidate, ProblemDetails } from "@embed-os/contracts";
import { DomainRuleError } from "@embed-os/domain";
import {
  ContactNotAvailableError,
  ConcurrencyConflictError,
  TaskNotFoundError,
} from "./application/task-completion.service.js";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyValidationError,
} from "./application/idempotency.js";
import {
  ContactDuplicateCandidatesError,
  ContactAlreadyLinkedError,
  ContactAlreadyMergedError,
  ContactMergeSameContactError,
  ContactMergeTargetRetiredError,
  ContactNotFoundError,
  ContactStateError,
  ContactVersionConflictError,
  OrganizationNotFoundError,
} from "./application/contact.js";
import {
  PlacementContextNotFoundError,
  PlacementNotFoundError,
  PlacementVersionConflictError,
} from "./placement.service.js";
import {
  OpportunityNotFoundError,
  OpportunityVersionConflictError,
} from "./opportunity.service.js";
import { OrganizationImportFileError } from "./application/organization-import.js";
import {
  OrganizationImportNotFoundError,
  OrganizationImportResolutionError,
  OrganizationImportStateError,
} from "./organization-import.service.js";
import {
  RadarCandidateNotFoundError,
  RadarCandidateStateError,
  RadarCandidateVersionConflictError,
} from "./radar.service.js";
import { PartnerNotFoundError } from "./partner.service.js";
import {
  ExportAuthenticationRequiredError,
  ExportIdentityConfigurationError,
  ExportPermissionDeniedError,
} from "./application/partner-export.js";
import {
  AccessPermissionDeniedError,
  AuthenticationRequiredError,
  IdentityConfigurationError,
} from "./auth/access-control.js";
import { SlaSettingsVersionConflictError } from "./sla-settings.service.js";
import {
  AccessUserAlreadyExistsError,
  AccessUserNotFoundError,
  AccessUserVersionConflictError,
} from "./access-administration.service.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestHeader = request.headers["x-request-id"];
    const rawRequestId = Array.isArray(requestHeader) ? requestHeader[0] : requestHeader;
    const requestId =
      rawRequestId && REQUEST_ID_PATTERN.test(rawRequestId) ? rawRequestId : randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = "Внутренняя ошибка";
    let detail = "Повторите запрос позднее";
    let code = "INTERNAL_ERROR";
    let fieldErrors: Record<string, string> | undefined;
    let duplicateCandidates: ContactCandidate[] | undefined;
    let currentVersion: number | undefined;

    if (exception instanceof DomainRuleError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      title = "Нарушено бизнес-правило";
      detail = exception.message;
      code = exception.code;
      fieldErrors = exception.fieldErrors;
    } else if (exception instanceof OrganizationImportFileError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      title = "Файл импорта отклонён";
      detail = exception.message;
      code = exception.code;
      fieldErrors = exception.fieldErrors;
    } else if (exception instanceof OrganizationImportResolutionError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      title = "Конфликты импорта не разрешены";
      detail = exception.message;
      code = exception.code;
      fieldErrors = exception.fieldErrors;
    } else if (exception instanceof OrganizationImportStateError) {
      status = HttpStatus.CONFLICT;
      title = "Импорт уже завершён";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof ContactDuplicateCandidatesError) {
      status = HttpStatus.CONFLICT;
      title = "Возможный дубликат контакта";
      detail = exception.message;
      code = exception.code;
      duplicateCandidates = exception.candidates;
    } else if (exception instanceof ContactAlreadyLinkedError) {
      status = HttpStatus.CONFLICT;
      title = "Контакт уже связан";
      detail = exception.message;
      code = exception.code;
    } else if (
      exception instanceof ContactAlreadyMergedError ||
      exception instanceof ContactMergeTargetRetiredError
    ) {
      status = HttpStatus.CONFLICT;
      title = "Контакт уже объединён";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof ContactMergeSameContactError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      title = "Некорректное слияние контактов";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof ContactVersionConflictError) {
      status = HttpStatus.CONFLICT;
      title = "Контакт уже изменён";
      detail = exception.message;
      code = exception.code;
      currentVersion = exception.currentVersion;
    } else if (exception instanceof ContactStateError) {
      status = HttpStatus.CONFLICT;
      title = "Недопустимое состояние контакта";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof ContactNotAvailableError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      title = "Контакт недоступен";
      detail = exception.message;
      code = exception.code;
      fieldErrors = exception.fieldErrors;
    } else if (exception instanceof ConcurrencyConflictError) {
      status = HttpStatus.CONFLICT;
      title = "Конфликт параллельного изменения";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof PlacementVersionConflictError) {
      status = HttpStatus.CONFLICT;
      title = "Конфликт параллельного изменения";
      detail = exception.message;
      code = exception.code;
      currentVersion = exception.currentVersion;
    } else if (exception instanceof OpportunityVersionConflictError) {
      status = HttpStatus.CONFLICT;
      title = "Конфликт параллельного изменения";
      detail = exception.message;
      code = exception.code;
      currentVersion = exception.currentVersion;
    } else if (exception instanceof SlaSettingsVersionConflictError) {
      status = HttpStatus.CONFLICT;
      title = "Настройки SLA уже изменены";
      detail = exception.message;
      code = exception.code;
      currentVersion = exception.currentVersion;
    } else if (exception instanceof AccessUserVersionConflictError) {
      status = HttpStatus.CONFLICT;
      title = "Права уже изменены";
      detail = exception.message;
      code = exception.code;
      currentVersion = exception.currentVersion;
    } else if (exception instanceof AccessUserAlreadyExistsError) {
      status = HttpStatus.CONFLICT;
      title = "Пользователь уже зарегистрирован";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof RadarCandidateVersionConflictError) {
      status = HttpStatus.CONFLICT;
      title = "Конфликт параллельного изменения";
      detail = exception.message;
      code = exception.code;
      currentVersion = exception.currentVersion;
    } else if (exception instanceof RadarCandidateStateError) {
      status = HttpStatus.CONFLICT;
      title = "Кандидат уже обработан";
      detail = exception.message;
      code = exception.code;
    } else if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof IdempotencyInProgressError
    ) {
      status = HttpStatus.CONFLICT;
      title = "Конфликт идемпотентности";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof IdempotencyKeyValidationError) {
      status = HttpStatus.BAD_REQUEST;
      title = "Некорректный Idempotency-Key";
      detail = exception.message;
      code = exception.code;
    } else if (
      exception instanceof TaskNotFoundError ||
      exception instanceof OrganizationNotFoundError ||
      exception instanceof ContactNotFoundError ||
      exception instanceof PlacementNotFoundError ||
      exception instanceof PlacementContextNotFoundError ||
      exception instanceof OpportunityNotFoundError ||
      exception instanceof OrganizationImportNotFoundError ||
      exception instanceof RadarCandidateNotFoundError ||
      exception instanceof PartnerNotFoundError ||
      exception instanceof AccessUserNotFoundError
    ) {
      status = HttpStatus.NOT_FOUND;
      title = "Объект не найден";
      detail = exception.message;
      code =
        exception instanceof OrganizationNotFoundError || exception instanceof ContactNotFoundError
          ? exception.code
          : exception instanceof PlacementNotFoundError ||
              exception instanceof PlacementContextNotFoundError
            ? exception.code
            : exception instanceof OpportunityNotFoundError
              ? exception.code
              : exception instanceof OrganizationImportNotFoundError
                ? exception.code
                : exception instanceof RadarCandidateNotFoundError
                  ? exception.code
                  : exception instanceof PartnerNotFoundError
                    ? exception.code
                    : exception instanceof AccessUserNotFoundError
                      ? exception.code
                      : "NOT_FOUND";
    } else if (exception instanceof AuthenticationRequiredError) {
      status = HttpStatus.UNAUTHORIZED;
      title = "Требуется аутентификация";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof AccessPermissionDeniedError) {
      status = HttpStatus.FORBIDDEN;
      title = "Недостаточно прав";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof IdentityConfigurationError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      title = "Аутентификация не настроена";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof ExportAuthenticationRequiredError) {
      status = HttpStatus.UNAUTHORIZED;
      title = "Требуется аутентификация";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof ExportPermissionDeniedError) {
      status = HttpStatus.FORBIDDEN;
      title = "Экспорт запрещён";
      detail = exception.message;
      code = exception.code;
    } else if (exception instanceof ExportIdentityConfigurationError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      title = "Экспорт не настроен";
      detail = exception.message;
      code = exception.code;
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === "P2034"
    ) {
      status = HttpStatus.CONFLICT;
      title = "Конфликт параллельного изменения";
      detail = "Транзакция не смогла завершиться из-за параллельного изменения. Повторите запрос";
      code = "SERIALIZATION_CONFLICT";
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === "P2002"
    ) {
      status = HttpStatus.CONFLICT;
      title = "Нарушена уникальность данных";
      detail = "Запись с такими уникальными значениями уже существует";
      code = "UNIQUE_CONSTRAINT_VIOLATION";
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      title = status === 404 ? "Объект не найден" : "Запрос отклонён";
      const body = exception.getResponse();
      detail = typeof body === "string" ? body : exception.message;
      code = status === 404 ? "NOT_FOUND" : "HTTP_ERROR";
    } else {
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error("Unhandled request error", stack);
    }

    const problem: ProblemDetails = {
      type: `https://embed-os.local/problems/${code.toLowerCase()}`,
      title,
      status,
      detail,
      code,
      requestId,
      ...(fieldErrors ? { fieldErrors } : {}),
      ...(duplicateCandidates ? { duplicateCandidates } : {}),
      ...(currentVersion !== undefined ? { currentVersion } : {}),
    };

    response.status(status).type("application/problem+json").json(problem);
  }
}
