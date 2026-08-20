import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessAdministrationService } from "./access-administration.service";
import { IdempotencyConflictError } from "./application/idempotency";
import type { PrismaService } from "./persistence/prisma.service";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const MANAGER_ID = "00000000-0000-4000-8000-000000000005";

describe("access administration", () => {
  let previousPersistence: string | undefined;
  let service: AccessAdministrationService;

  beforeEach(() => {
    previousPersistence = process.env.PERSISTENCE_MODE;
    process.env.PERSISTENCE_MODE = "memory";
    service = new AccessAdministrationService({} as PrismaService);
  });

  afterEach(() => {
    if (previousPersistence === undefined) delete process.env.PERSISTENCE_MODE;
    else process.env.PERSISTENCE_MODE = previousPersistence;
  });

  it("lists the editable role matrix and resolves development identities from it", async () => {
    const payload = await service.list(ADMIN_ID);

    expect(payload.users).toHaveLength(5);
    expect(payload.teams).toEqual([{ id: "00000000-0000-4000-8000-000000000002", name: "Команда внедрения" }]);
    expect(payload.users.find(({ id }) => id === ADMIN_ID)).toMatchObject({
      role: "admin",
      currentUser: true,
    });
    expect(payload.roleDefaults.partner_manager).toContain("tasks.write");
    expect(service.resolveDevelopmentIdentity("bootstrap:sergey.volkov")).toMatchObject({
      role: "partner_manager",
      scope: { mode: "own" },
    });
  });

  it("pre-registers an OIDC identity idempotently and rejects duplicate identities", async () => {
    const command = {
      subject: "oidc:ivan.petrov",
      displayName: "Иван Петров",
      email: "ivan.petrov@example.test",
      teamId: "00000000-0000-4000-8000-000000000002",
      role: "partner_manager" as const,
      permissions: ["today.read", "partners.read", "tasks.write"] as const,
      reason: "Регистрация участника пилота",
    };
    const first = await service.create(ADMIN_ID, command, "access-create-test-0001");
    const replay = await service.create(ADMIN_ID, command, "access-create-test-0001");

    expect(replay).toEqual(first);
    expect(service.resolveDevelopmentIdentity("oidc:ivan.petrov")).toMatchObject({
      userId: first.id,
      role: "partner_manager",
      scope: { mode: "own" },
    });
    await expect(service.create(ADMIN_ID, {
      ...command,
      subject: "oidc:another-subject",
    }, "access-create-test-0002")).rejects.toMatchObject({ code: "ACCESS_USER_ALREADY_EXISTS" });
  });

  it("updates access idempotently and applies it to the next session", async () => {
    const before = (await service.list(ADMIN_ID)).users.find(({ id }) => id === MANAGER_ID)!;
    const command = {
      version: before.version,
      status: "active" as const,
      role: "analyst" as const,
      permissions: ["today.read", "partners.read", "reports.view", "reports.generate"] as const,
      reason: "Перевод в аналитическую команду",
    };
    const first = await service.update(ADMIN_ID, MANAGER_ID, command, "access-update-test-0001");
    const replay = await service.update(ADMIN_ID, MANAGER_ID, command, "access-update-test-0001");

    expect(first).toMatchObject({ role: "analyst", version: before.version + 1 });
    expect(replay).toEqual(first);
    expect(service.resolveDevelopmentIdentity("bootstrap:sergey.volkov")).toMatchObject({
      role: "analyst",
      permissions: expect.arrayContaining(["reports.generate"]),
    });
    await expect(service.update(ADMIN_ID, MANAGER_ID, {
      ...command,
      reason: "Другое содержимое команды",
    }, "access-update-test-0001")).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("blocks self-modification and removal of the last administrator", async () => {
    const admin = (await service.list(ADMIN_ID)).users.find(({ id }) => id === ADMIN_ID)!;
    const command = {
      version: admin.version,
      status: "active" as const,
      role: "observer" as const,
      permissions: ["today.read"] as const,
      reason: "Проверка защиты администратора",
    };

    await expect(service.update(ADMIN_ID, ADMIN_ID, command, "access-self-test-0001"))
      .rejects.toMatchObject({ code: "ACCESS_SELF_MODIFICATION" });
    await expect(service.update(MANAGER_ID, ADMIN_ID, command, "access-last-admin-test-0001"))
      .rejects.toMatchObject({ code: "ACCESS_LAST_ADMIN" });
  });
});
