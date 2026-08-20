import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma, UserStatus } from "@prisma/client";
import {
  actorPermissions,
  actorRoles,
  type AccessAdministrationPayload,
  type AccessUserView,
  type ActorPermission,
  type ActorRole,
  type CreateAccessUserCommand,
  type SessionPayload,
  type UpdateAccessUserCommand,
} from "@embed-os/contracts";
import { DomainRuleError } from "@embed-os/domain";
import {
  accessUserRequestHash,
  accessUserCreateRequestHash,
  IdempotencyConflictError,
  IdempotencyInProgressError,
} from "./application/idempotency.js";
import { PrismaService } from "./persistence/prisma.service.js";

const TEAM_ID = "00000000-0000-4000-8000-000000000002";
const TEAM_NAME = "Команда внедрения";
const MANAGED_ROLE_PERMISSIONS = actorRoles.map((role) => `role:${role}`);
const MANAGED_PERMISSIONS = [...actorPermissions, ...MANAGED_ROLE_PERMISSIONS];
const READ_PERMISSIONS: ActorPermission[] = [
  "today.read",
  "partners.read",
  "contacts.view",
  "opportunities.read",
  "radar.read",
  "placements.read",
  "reports.view",
];

export const accessRoleDefaults: Record<ActorRole, ActorPermission[]> = {
  partner_manager: [
    ...READ_PERMISSIONS,
    "tasks.write",
    "partners.write",
    "partners.export",
    "contacts.write",
    "opportunities.stage.write",
    "radar.write",
    "imports.organizations.write",
  ],
  team_lead: [
    ...READ_PERMISSIONS,
    "tasks.write",
    "partners.write",
    "partners.export",
    "partners.export.audit",
    "contacts.write",
    "opportunities.stage.write",
    "radar.write",
    "placements.write",
    "reports.generate",
    "imports.organizations.write",
  ],
  technical_specialist: [
    "today.read",
    "partners.read",
    "contacts.view",
    "opportunities.read",
    "radar.read",
    "placements.read",
    "placements.write",
    "reports.view",
  ],
  analyst: [...READ_PERMISSIONS, "partners.export", "partners.export.audit", "reports.generate"],
  legal: ["partners.read", "contacts.view", "opportunities.read", "reports.view"],
  admin: [...actorPermissions],
  observer: [...READ_PERMISSIONS],
};

export class AccessUserNotFoundError extends Error {
  readonly code = "ACCESS_USER_NOT_FOUND";

  constructor() {
    super("Пользователь не найден");
    this.name = "AccessUserNotFoundError";
  }
}

export class AccessUserVersionConflictError extends Error {
  readonly code = "ACCESS_USER_VERSION_CONFLICT";

  constructor(readonly currentVersion: number) {
    super(`Права уже изменены. Актуальная версия: ${currentVersion}`);
    this.name = "AccessUserVersionConflictError";
  }
}

export class AccessUserAlreadyExistsError extends Error {
  readonly code = "ACCESS_USER_ALREADY_EXISTS";

  constructor() {
    super("Пользователь с таким OIDC subject или email уже зарегистрирован");
    this.name = "AccessUserAlreadyExistsError";
  }
}

type MemoryAccessUser = Omit<AccessUserView, "currentUser">;

@Injectable()
export class AccessAdministrationService {
  private readonly memoryUsers = new Map<string, MemoryAccessUser>(
    seedMemoryUsers().map((user) => [user.id, user]),
  );
  private readonly memoryIdempotency = new Map<
    string,
    {
      requestHash: string;
      response: AccessUserView;
    }
  >();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(actorId: string): Promise<AccessAdministrationPayload> {
    const result =
      process.env.PERSISTENCE_MODE === "postgres"
        ? await this.listPostgres(actorId)
        : {
            users: [...this.memoryUsers.values()]
              .sort((left, right) => left.displayName.localeCompare(right.displayName, "ru"))
              .map((user) => ({ ...structuredClone(user), currentUser: user.id === actorId })),
            teams: [{ id: TEAM_ID, name: TEAM_NAME }],
          };
    return {
      ...result,
      roles: [...actorRoles],
      permissions: [...actorPermissions],
      roleDefaults: structuredClone(accessRoleDefaults),
    };
  }

  async create(actorId: string, input: unknown, idempotencyKey: string): Promise<AccessUserView> {
    const command = parseCreateAccessUserCommand(input);
    return process.env.PERSISTENCE_MODE === "postgres"
      ? this.createPostgres(actorId, command, idempotencyKey)
      : this.createMemory(actorId, command, idempotencyKey);
  }

  async update(
    actorId: string,
    targetUserId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<AccessUserView> {
    const command = parseUpdateAccessUserCommand(input);
    if (!isUuid(targetUserId)) throw new AccessUserNotFoundError();
    return process.env.PERSISTENCE_MODE === "postgres"
      ? this.updatePostgres(actorId, targetUserId, command, idempotencyKey)
      : this.updateMemory(actorId, targetUserId, command, idempotencyKey);
  }

  resolveDevelopmentIdentity(subject: string): SessionPayload | null {
    const user = [...this.memoryUsers.values()].find((candidate) => candidate.subject === subject);
    if (!user || user.status !== "active") return null;
    return {
      subject: user.subject,
      userId: user.id,
      displayName: user.displayName,
      initials: initialsFor(user.displayName),
      email: user.email,
      role: user.role,
      permissions: effectivePermissions(user.role, user.permissions),
      scope: {
        mode: scopeFor(user.role),
        teamId: user.teamId,
        teamName: user.teamName,
      },
    };
  }

  private async updateMemory(
    actorId: string,
    targetUserId: string,
    command: UpdateAccessUserCommand,
    idempotencyKey: string,
  ) {
    const requestHash = accessUserRequestHash(command);
    const scope = `${actorId}:${targetUserId}:${idempotencyKey}`;
    const replay = this.memoryIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const current = this.memoryUsers.get(targetUserId);
    if (!current) throw new AccessUserNotFoundError();
    if (current.version !== command.version) {
      throw new AccessUserVersionConflictError(current.version);
    }
    assertSafeAccessChange(actorId, current, command, [...this.memoryUsers.values()]);
    const updated: MemoryAccessUser = {
      ...current,
      role: command.role,
      permissions: [...command.permissions],
      status: command.status,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.memoryUsers.set(updated.id, updated);
    const response = { ...structuredClone(updated), currentUser: updated.id === actorId };
    this.memoryIdempotency.set(scope, { requestHash, response });
    return structuredClone(response);
  }

  private async listPostgres(actorId: string) {
    const [users, teams] = await Promise.all([
      this.prisma.user.findMany({
        where: { externalSubject: { not: { startsWith: "system:" } } },
        include: {
          team: { select: { name: true } },
          permissions: { where: { revokedAt: null }, select: { permission: true } },
        },
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
      }),
      this.prisma.team.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] }),
    ]);
    return {
      users: users.map((user) => postgresUserView(user, actorId)),
      teams: teams.map(({ id, name }) => ({ id, name })),
    };
  }

  private createMemory(
    actorId: string,
    command: CreateAccessUserCommand,
    idempotencyKey: string,
  ): AccessUserView {
    const requestHash = accessUserCreateRequestHash(command);
    const scope = `create:${actorId}:${idempotencyKey}`;
    const replay = this.memoryIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    if (
      [...this.memoryUsers.values()].some(
        (user) =>
          user.subject === command.subject ||
          user.email.toLocaleLowerCase() === command.email.toLocaleLowerCase(),
      )
    )
      throw new AccessUserAlreadyExistsError();
    if (command.teamId !== null && command.teamId !== TEAM_ID) {
      throw accessValidation({ teamId: "Команда не найдена" });
    }
    const now = new Date().toISOString();
    const created: MemoryAccessUser = {
      id: randomUUID(),
      subject: command.subject,
      displayName: command.displayName,
      email: command.email,
      teamId: command.teamId,
      teamName: command.teamId === TEAM_ID ? TEAM_NAME : null,
      status: "active",
      role: command.role,
      permissions: effectivePermissions(command.role, command.permissions),
      version: 1,
      updatedAt: now,
    };
    this.memoryUsers.set(created.id, created);
    const response = { ...structuredClone(created), currentUser: false };
    this.memoryIdempotency.set(scope, { requestHash, response });
    return response;
  }

  private async createPostgres(
    actorId: string,
    command: CreateAccessUserCommand,
    idempotencyKey: string,
  ): Promise<AccessUserView> {
    const requestHash = accessUserCreateRequestHash(command);
    const reservationId = randomUUID();
    const userId = randomUUID();
    const now = new Date();
    return this.prisma
      .$transaction(
        async (transaction) => {
          const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "idempotency_record" (
          "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
        ) VALUES (
          ${reservationId}::uuid,
          ${actorId}::uuid,
          ${"settings.access.user.create"},
          ${idempotencyKey},
          ${requestHash},
          ${now},
          ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)}
        )
        ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
        RETURNING "id"
      `);
          if (inserted.length === 0) {
            const existing = await transaction.idempotencyRecord.findUnique({
              where: {
                actorId_operation_requestKey: {
                  actorId,
                  operation: "settings.access.user.create",
                  requestKey: idempotencyKey,
                },
              },
            });
            if (!existing) throw new IdempotencyInProgressError(idempotencyKey);
            if (existing.requestHash !== requestHash)
              throw new IdempotencyConflictError(idempotencyKey);
            const replay = parseAccessUserResponse(existing.responseJson);
            if (!replay) throw new IdempotencyInProgressError(idempotencyKey);
            return replay;
          }

          const duplicate = await transaction.user.findFirst({
            where: { OR: [{ externalSubject: command.subject }, { email: command.email }] },
            select: { id: true },
          });
          if (duplicate) throw new AccessUserAlreadyExistsError();
          if (command.teamId) {
            const team = await transaction.team.findUnique({
              where: { id: command.teamId },
              select: { id: true },
            });
            if (!team) throw accessValidation({ teamId: "Команда не найдена" });
          }
          await transaction.user.create({
            data: {
              id: userId,
              externalSubject: command.subject,
              displayName: command.displayName,
              email: command.email,
              teamId: command.teamId,
              status: UserStatus.ACTIVE,
              timezone: "Europe/Moscow",
            },
          });
          await transaction.userPermission.createMany({
            data: [`role:${command.role}`, ...command.permissions].map((permission) => ({
              userId,
              permission,
              source: `admin:${actorId}`,
              grantedAt: now,
            })),
            skipDuplicates: true,
          });
          const created = await transaction.user.findUniqueOrThrow({
            where: { id: userId },
            include: {
              team: { select: { name: true } },
              permissions: { where: { revokedAt: null }, select: { permission: true } },
            },
          });
          const response = postgresUserView(created, actorId);
          await transaction.auditLog.create({
            data: {
              id: randomUUID(),
              actorId,
              action: "settings.access.user-created",
              entityType: "User",
              entityId: userId,
              beforeJson: Prisma.DbNull,
              afterJson: toJson({ ...accessSnapshot(response), reason: command.reason }),
              occurredAt: now,
            },
          });
          await transaction.outboxEvent.create({
            data: {
              id: randomUUID(),
              eventType: "settings.access.user-created",
              aggregateType: "User",
              aggregateId: userId,
              aggregateVersion: 1,
              schemaVersion: 1,
              payload: toJson({ ...accessSnapshot(response), actorId, reason: command.reason }),
              occurredAt: now,
            },
          });
          await transaction.idempotencyRecord.update({
            where: { id: reservationId },
            data: { responseStatus: 201, responseJson: toJson(response), completedAt: now },
          });
          return response;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new AccessUserAlreadyExistsError();
        }
        throw error;
      });
  }

  private async updatePostgres(
    actorId: string,
    targetUserId: string,
    command: UpdateAccessUserCommand,
    idempotencyKey: string,
  ): Promise<AccessUserView> {
    const requestHash = accessUserRequestHash(command);
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(
      async (transaction) => {
        const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "idempotency_record" (
          "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
        ) VALUES (
          ${reservationId}::uuid,
          ${actorId}::uuid,
          ${"settings.access.user.update"},
          ${idempotencyKey},
          ${requestHash},
          ${now},
          ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)}
        )
        ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
        RETURNING "id"
      `);
        if (inserted.length === 0) {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              actorId_operation_requestKey: {
                actorId,
                operation: "settings.access.user.update",
                requestKey: idempotencyKey,
              },
            },
          });
          if (!existing) throw new IdempotencyInProgressError(idempotencyKey);
          if (existing.requestHash !== requestHash)
            throw new IdempotencyConflictError(idempotencyKey);
          const replay = parseAccessUserResponse(existing.responseJson);
          if (!replay) throw new IdempotencyInProgressError(idempotencyKey);
          return replay;
        }

        await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "user_account" WHERE "id" = ${targetUserId}::uuid FOR UPDATE
      `);
        const current = await transaction.user.findUnique({
          where: { id: targetUserId },
          include: {
            team: { select: { name: true } },
            permissions: { where: { revokedAt: null }, select: { permission: true } },
          },
        });
        if (!current || current.externalSubject.startsWith("system:")) {
          throw new AccessUserNotFoundError();
        }
        if (current.version !== command.version) {
          throw new AccessUserVersionConflictError(current.version);
        }
        const currentView = postgresUserView(current, actorId);
        if (targetUserId === actorId && accessChanged(currentView, command)) {
          throw unsafeChange(
            "ACCESS_SELF_MODIFICATION",
            "Нельзя изменять собственную роль, статус или разрешения",
          );
        }
        if (
          currentView.status === "active" &&
          currentView.role === "admin" &&
          (command.status !== "active" || command.role !== "admin")
        ) {
          const otherAdmins = await transaction.user.count({
            where: {
              id: { not: targetUserId },
              status: UserStatus.ACTIVE,
              permissions: {
                some: { permission: "role:admin", revokedAt: null },
              },
            },
          });
          if (otherAdmins === 0) {
            throw unsafeChange(
              "ACCESS_LAST_ADMIN",
              "Нельзя отключить или понизить последнего администратора",
            );
          }
        }

        const changed = await transaction.user.updateMany({
          where: { id: targetUserId, version: command.version },
          data: {
            status: command.status === "active" ? UserStatus.ACTIVE : UserStatus.INACTIVE,
            version: { increment: 1 },
            updatedAt: now,
          },
        });
        if (changed.count !== 1) throw new AccessUserVersionConflictError(command.version + 1);

        const desired = [`role:${command.role}`, ...command.permissions];
        await transaction.userPermission.updateMany({
          where: {
            userId: targetUserId,
            revokedAt: null,
            permission: { in: MANAGED_PERMISSIONS, notIn: desired },
          },
          data: { revokedAt: now },
        });
        for (const permission of desired) {
          await transaction.userPermission.upsert({
            where: { userId_permission: { userId: targetUserId, permission } },
            update: { revokedAt: null, grantedAt: now, source: `admin:${actorId}` },
            create: {
              userId: targetUserId,
              permission,
              grantedAt: now,
              source: `admin:${actorId}`,
            },
          });
        }

        const updated = await transaction.user.findUniqueOrThrow({
          where: { id: targetUserId },
          include: {
            team: { select: { name: true } },
            permissions: { where: { revokedAt: null }, select: { permission: true } },
          },
        });
        const response = postgresUserView(updated, actorId);
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId,
            action: "settings.access.user-updated",
            entityType: "User",
            entityId: targetUserId,
            beforeJson: toJson(accessSnapshot(currentView)),
            afterJson: toJson({ ...accessSnapshot(response), reason: command.reason }),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: "settings.access.user-updated",
            aggregateType: "User",
            aggregateId: targetUserId,
            aggregateVersion: response.version,
            schemaVersion: 1,
            payload: toJson({ ...accessSnapshot(response), actorId, reason: command.reason }),
            occurredAt: now,
          },
        });
        await transaction.idempotencyRecord.update({
          where: { id: reservationId },
          data: {
            responseStatus: 200,
            responseJson: toJson(response),
            completedAt: now,
          },
        });
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

function parseCreateAccessUserCommand(input: unknown): CreateAccessUserCommand {
  if (!isRecord(input)) throw accessValidation({ command: "Передайте данные пользователя" });
  const fieldErrors: Record<string, string> = {};
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (subject.length < 3 || subject.length > 255) {
    fieldErrors.subject = "OIDC subject должен содержать от 3 до 255 символов";
  }
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (displayName.length < 2 || displayName.length > 200) {
    fieldErrors.displayName = "Имя должно содержать от 2 до 200 символов";
  }
  const email = typeof input.email === "string" ? input.email.trim().toLocaleLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    fieldErrors.email = "Укажите корректный корпоративный email";
  }
  const teamId =
    input.teamId === null || input.teamId === undefined || input.teamId === ""
      ? null
      : typeof input.teamId === "string" && isUuid(input.teamId)
        ? input.teamId
        : ((fieldErrors.teamId = "Выберите существующую команду"), null);
  const role = actorRoles.find((candidate) => candidate === input.role);
  if (!role) fieldErrors.role = "Выберите поддерживаемую роль";
  const permissions = Array.isArray(input.permissions)
    ? [...new Set(input.permissions.filter(isActorPermission))]
    : [];
  if (!Array.isArray(input.permissions) || permissions.length !== input.permissions.length) {
    fieldErrors.permissions = "Список содержит неизвестные или повторяющиеся разрешения";
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5 || reason.length > 1_000) {
    fieldErrors.reason = "Укажите причину длиной от 5 до 1000 символов";
  }
  if (Object.keys(fieldErrors).length > 0 || !role) throw accessValidation(fieldErrors);
  return { subject, displayName, email, teamId, role, permissions, reason };
}

function parseUpdateAccessUserCommand(input: unknown): UpdateAccessUserCommand {
  if (!isRecord(input)) throw accessValidation({ command: "Передайте настройки пользователя" });
  const fieldErrors: Record<string, string> = {};
  const version =
    Number.isInteger(input.version) && Number(input.version) > 0
      ? Number(input.version)
      : ((fieldErrors.version = "Версия должна быть положительным целым числом"), 0);
  const status =
    input.status === "active" || input.status === "inactive"
      ? input.status
      : ((fieldErrors.status = "Выберите статус active или inactive"), "active");
  const role = actorRoles.find((candidate) => candidate === input.role);
  if (!role) fieldErrors.role = "Выберите поддерживаемую роль";
  const permissions = Array.isArray(input.permissions)
    ? [...new Set(input.permissions.filter(isActorPermission))]
    : [];
  if (!Array.isArray(input.permissions) || permissions.length !== input.permissions.length) {
    fieldErrors.permissions = "Список содержит неизвестные или повторяющиеся разрешения";
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5 || reason.length > 1_000) {
    fieldErrors.reason = "Укажите причину длиной от 5 до 1000 символов";
  }
  if (Object.keys(fieldErrors).length > 0 || !role) throw accessValidation(fieldErrors);
  return { version, status, role, permissions, reason };
}

function assertSafeAccessChange(
  actorId: string,
  current: MemoryAccessUser,
  command: UpdateAccessUserCommand,
  allUsers: MemoryAccessUser[],
) {
  if (actorId === current.id && accessChanged(current, command)) {
    throw unsafeChange(
      "ACCESS_SELF_MODIFICATION",
      "Нельзя изменять собственную роль, статус или разрешения",
    );
  }
  if (
    current.status === "active" &&
    current.role === "admin" &&
    (command.status !== "active" || command.role !== "admin") &&
    !allUsers.some(
      (user) => user.id !== current.id && user.status === "active" && user.role === "admin",
    )
  ) {
    throw unsafeChange(
      "ACCESS_LAST_ADMIN",
      "Нельзя отключить или понизить последнего администратора",
    );
  }
}

function accessChanged(
  current: Pick<AccessUserView, "role" | "status" | "permissions">,
  command: UpdateAccessUserCommand,
) {
  return (
    current.role !== command.role ||
    current.status !== command.status ||
    [...current.permissions].sort().join("|") !== [...command.permissions].sort().join("|")
  );
}

function postgresUserView(
  user: {
    id: string;
    externalSubject: string;
    displayName: string;
    email: string;
    teamId: string | null;
    team: { name: string } | null;
    status: UserStatus;
    version: number;
    updatedAt: Date;
    permissions: Array<{ permission: string }>;
  },
  actorId: string,
): AccessUserView {
  const raw = user.permissions.map(({ permission }) => permission);
  const role = roleFrom(raw);
  return {
    id: user.id,
    subject: user.externalSubject,
    displayName: user.displayName,
    email: user.email,
    teamId: user.teamId,
    teamName: user.team?.name ?? null,
    status: user.status === UserStatus.ACTIVE ? "active" : "inactive",
    role,
    permissions: effectivePermissions(role, raw.filter(isActorPermission)),
    version: user.version,
    updatedAt: user.updatedAt.toISOString(),
    currentUser: user.id === actorId,
  };
}

function seedMemoryUsers(): MemoryAccessUser[] {
  const updatedAt = "2026-08-19T09:00:00.000Z";
  return [
    memoryUser(
      "00000000-0000-4000-8000-000000000001",
      "bootstrap:anna.sokolova",
      "Анна Соколова",
      "anna.sokolova@example.invalid",
      "admin",
      updatedAt,
    ),
    memoryUser(
      "00000000-0000-4000-8000-000000000003",
      "bootstrap:observer",
      "Наблюдатель",
      "observer@example.invalid",
      "observer",
      updatedAt,
    ),
    memoryUser(
      "00000000-0000-4000-8000-000000000005",
      "bootstrap:sergey.volkov",
      "Сергей Волков",
      "sergey.volkov@example.invalid",
      "partner_manager",
      updatedAt,
    ),
    memoryUser(
      "00000000-0000-4000-8000-000000000006",
      "bootstrap:elena.orlova",
      "Елена Орлова",
      "elena.orlova@example.invalid",
      "team_lead",
      updatedAt,
    ),
    memoryUser(
      "00000000-0000-4000-8000-000000000007",
      "bootstrap:mikhail.lebedev",
      "Михаил Лебедев",
      "mikhail.lebedev@example.invalid",
      "technical_specialist",
      updatedAt,
    ),
  ];
}

function memoryUser(
  id: string,
  subject: string,
  displayName: string,
  email: string,
  role: ActorRole,
  updatedAt: string,
): MemoryAccessUser {
  return {
    id,
    subject,
    displayName,
    email,
    teamId: TEAM_ID,
    teamName: TEAM_NAME,
    status: "active",
    role,
    permissions: [...accessRoleDefaults[role]],
    version: 1,
    updatedAt,
  };
}

function roleFrom(permissions: string[]): ActorRole {
  const raw = permissions.find((permission) => permission.startsWith("role:"))?.slice(5);
  return actorRoles.find((role) => role === raw) ?? "observer";
}

function effectivePermissions(role: ActorRole, permissions: ActorPermission[]) {
  return role === "admin" ? [...actorPermissions] : [...permissions];
}

function isActorPermission(value: unknown): value is ActorPermission {
  return typeof value === "string" && actorPermissions.some((permission) => permission === value);
}

function accessSnapshot(user: AccessUserView) {
  return {
    userId: user.id,
    subject: user.subject,
    status: user.status,
    role: user.role,
    permissions: user.permissions,
    version: user.version,
  };
}

function parseAccessUserResponse(value: unknown): AccessUserView | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.version === "number"
    ? (value as unknown as AccessUserView)
    : null;
}

function accessValidation(fieldErrors: Record<string, string>) {
  return new DomainRuleError(
    "ACCESS_SETTINGS_INVALID",
    "Проверьте настройки роли и разрешений",
    fieldErrors,
  );
}

function unsafeChange(code: string, message: string) {
  return new DomainRuleError(code, message, { user: message });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
