import { randomUUID } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import type { Request } from "express";
import {
  actorPermissions,
  actorRoles,
  type ActorPermission,
  type ActorRole,
  type SessionPayload,
} from "@embed-os/contracts";
import { PrismaService } from "../persistence/prisma.service.js";
import { AccessAdministrationService } from "../access-administration.service.js";
import {
  OIDC_TOKEN_VERIFIER,
  OidcConfigurationError,
  OidcTokenVerificationError,
  type OidcTokenVerifierPort,
} from "./oidc-token-verifier.js";

import { AUTH_MODE_LOCAL_PASSWORD } from "./auth-base.js";
import { verifyLocalSessionToken } from "./local-auth.js";

export const ACTOR_IDENTITY = Symbol("ACTOR_IDENTITY");
const REQUIRED_PERMISSION = "access-control:required-permission";

// Базовые ошибки и PublicRoute вынесены в auth-base.ts (разрыв цикла
// импортов); импортируем для внутреннего использования и реэкспортируем,
// чтобы существующие внешние импорты не менялись.
import {
  AccessPermissionDeniedError,
  AuthenticationRequiredError,
  IdentityConfigurationError,
  PUBLIC_ROUTE,
  PublicRoute,
} from "./auth-base.js";
export {
  AccessPermissionDeniedError,
  AuthenticationRequiredError,
  IdentityConfigurationError,
  PublicRoute,
};

const BOOTSTRAP_SUBJECT = "bootstrap:anna.sokolova";

export type ActorContext = SessionPayload;

export interface ActorRequest extends Request {
  actor?: ActorContext;
}

export interface ActorIdentityPort {
  resolve(subject: string): Promise<ActorContext>;
}

export const RequirePermission = (permission: ActorPermission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

@Injectable()
export class ActorIdentityService implements ActorIdentityPort {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(AccessAdministrationService)
    private readonly access: AccessAdministrationService,
  ) {}

  async resolve(subject: string): Promise<ActorContext> {
    if (process.env.PERSISTENCE_MODE !== "postgres") {
      return this.resolveDevelopmentIdentity(subject);
    }

    const user = await this.prisma.user.findUnique({
      where: { externalSubject: subject },
      select: {
        id: true,
        displayName: true,
        email: true,
        status: true,
        teamId: true,
        team: { select: { name: true } },
        permissions: {
          where: { revokedAt: null },
          select: { permission: true },
        },
      },
    });
    if (!user || user.status !== "ACTIVE") throw new AuthenticationRequiredError();

    const rawPermissions = user.permissions.map(({ permission }) => permission);
    const role = parseRole(rawPermissions) ?? "observer";
    const permissions =
      role === "admin" ? [...actorPermissions] : rawPermissions.filter(isActorPermission);
    return {
      subject,
      userId: user.id,
      displayName: user.displayName,
      initials: initialsFor(user.displayName),
      email: user.email,
      role,
      permissions,
      scope: {
        mode: scopeFor(role),
        teamId: user.teamId,
        teamName: user.team?.name ?? null,
      },
    };
  }

  private resolveDevelopmentIdentity(subject: string): ActorContext {
    const identity = this.access.resolveDevelopmentIdentity(subject);
    if (!identity) throw new AuthenticationRequiredError();
    return identity;
  }
}

@Injectable()
export class AccessControlGuard implements CanActivate {
  private readonly logger = new Logger(AccessControlGuard.name);

  constructor(
    @Inject(ACTOR_IDENTITY) private readonly identities: ActorIdentityPort,
    @Inject(OIDC_TOKEN_VERIFIER) private readonly oidcTokens: OidcTokenVerifierPort,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = metadata<boolean>(PUBLIC_ROUTE, context);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<ActorRequest>();
    const subject = await resolveRequestSubject(request, this.oidcTokens);
    const actor = await this.identities.resolve(subject);
    request.actor = actor;

    const permission = metadata<ActorPermission>(REQUIRED_PERMISSION, context);
    if (!permission || actor.role === "admin" || actor.permissions.includes(permission)) {
      return true;
    }

    await this.recordDeniedAccess(actor, permission, request);
    throw new AccessPermissionDeniedError(permission);
  }

  private async recordDeniedAccess(
    actor: ActorContext,
    permission: ActorPermission,
    request: ActorRequest,
  ) {
    this.logger.warn(
      `${actor.subject} denied ${permission} for ${request.method} ${request.originalUrl}`,
    );
    if (process.env.PERSISTENCE_MODE !== "postgres") return;
    try {
      await this.prisma.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: actor.userId,
          action: "access.denied",
          entityType: "AccessControl",
          entityId: actor.userId,
          beforeJson: undefined,
          afterJson: {
            permission,
            method: request.method,
            path: request.originalUrl.slice(0, 1000),
            subject: actor.subject,
          },
          occurredAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(
        "Failed to append access denial audit",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

function metadata<T>(key: string, context: ExecutionContext): T | undefined {
  return (
    Reflect.getMetadata(key, context.getHandler()) ?? Reflect.getMetadata(key, context.getClass())
  );
}

export async function resolveRequestSubject(
  request: Pick<Request, "headers">,
  oidcTokens: OidcTokenVerifierPort,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const mode = authenticationMode(environment);
  if (mode === "oidc_jwt") {
    const token = bearerToken(request.headers.authorization);
    try {
      return await oidcTokens.verify(token);
    } catch (error) {
      if (error instanceof OidcConfigurationError) {
        throw new IdentityConfigurationError(error.message);
      }
      if (error instanceof OidcTokenVerificationError) {
        throw new AuthenticationRequiredError(error.message);
      }
      throw error;
    }
  }

  if (mode === AUTH_MODE_LOCAL_PASSWORD) {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw new AuthenticationRequiredError();
    return validateSubject(await verifyLocalSessionToken(token));
  }

  const rawHeader = request.headers["x-embed-actor"];
  const supplied = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (mode === "trusted_proxy") {
    if (environment.TRUSTED_IDENTITY_HEADER !== "true") {
      throw new IdentityConfigurationError(
        "AUTH_MODE=trusted_proxy требует TRUSTED_IDENTITY_HEADER=true и закрытого сетевого доступа к API",
      );
    }
    if (!supplied?.trim()) throw new AuthenticationRequiredError();
    return validateSubject(supplied);
  }
  return supplied?.trim() ? validateSubject(supplied) : BOOTSTRAP_SUBJECT;
}

function authenticationMode(environment: NodeJS.ProcessEnv) {
  const configured = environment.AUTH_MODE?.trim();
  const production = environment.NODE_ENV === "production";
  if (!configured) {
    if (!production) return "development" as const;
    if (environment.TRUSTED_IDENTITY_HEADER === "true") return "trusted_proxy" as const;
    throw new IdentityConfigurationError();
  }
  if (configured === "development") {
    if (production) {
      throw new IdentityConfigurationError("AUTH_MODE=development запрещён в production");
    }
    return configured;
  }
  if (configured === AUTH_MODE_LOCAL_PASSWORD) return configured;
  if (configured === "trusted_proxy" || configured === "oidc_jwt") return configured;
  throw new IdentityConfigurationError(
    "AUTH_MODE должен быть development, trusted_proxy, oidc_jwt или local_password",
  );
}

function bearerToken(rawHeader: string | string[] | undefined) {
  const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const match = value?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match?.[1]) {
    throw new AuthenticationRequiredError("Передайте OIDC access token в Authorization: Bearer");
  }
  return match[1];
}

function validateSubject(subject: string) {
  const normalized = subject.trim();
  if (!/^[a-zA-Z0-9._:@/-]{3,200}$/.test(normalized)) {
    throw new AuthenticationRequiredError("Некорректный идентификатор учётной записи");
  }
  return normalized;
}

function parseRole(permissions: string[]): ActorRole | null {
  const rawRole = permissions
    .find((permission) => permission.startsWith("role:"))
    ?.slice("role:".length);
  return actorRoles.find((role) => role === rawRole) ?? null;
}

function isActorPermission(value: string): value is ActorPermission {
  return actorPermissions.some((permission) => permission === value);
}

function scopeFor(role: ActorRole): SessionPayload["scope"]["mode"] {
  if (role === "admin") return "all";
  if (role === "team_lead" || role === "analyst" || role === "observer") return "team";
  if (role === "technical_specialist") return "assigned";
  return "own";
}

function initialsFor(displayName: string) {
  return (
    displayName
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase("ru-RU") ?? "")
      .join("") || "?"
  );
}
