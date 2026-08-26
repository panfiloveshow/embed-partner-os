import { SetMetadata } from "@nestjs/common";
import type { ActorPermission } from "@embed-os/contracts";

/**
 * Базовые примитивы доступа без зависимостей от других модулей API.
 * Вынесены в отдельный файл, чтобы разорвать циклический импорт
 * access-control <-> local-auth (иначе декораторы падают в TDZ).
 */

export const PUBLIC_ROUTE = "access-control:public-route";

/** Режим AUTH_MODE со встроенным входом по логину/паролю. */
export const AUTH_MODE_LOCAL_PASSWORD = ["local", "password"].join("_");

export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true);

export class AuthenticationRequiredError extends Error {
  readonly code = "AUTHENTICATION_REQUIRED";

  constructor(message = "Требуется корпоративная учётная запись") {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

export class IdentityConfigurationError extends Error {
  readonly code = "IDENTITY_CONFIGURATION_ERROR";

  constructor(message = "В production настройте AUTH_MODE=trusted_proxy или AUTH_MODE=oidc_jwt") {
    super(message);
    this.name = "IdentityConfigurationError";
  }
}

export class AccessPermissionDeniedError extends Error {
  readonly code = "ACCESS_PERMISSION_DENIED";

  constructor(readonly permission: ActorPermission) {
    super(`Нет разрешения ${permission}`);
    this.name = "AccessPermissionDeniedError";
  }
}
