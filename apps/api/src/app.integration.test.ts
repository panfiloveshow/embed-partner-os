import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "./app.module.js";
import { ProblemDetailsFilter } from "./problem-details.filter.js";
import { RADAR_INSPECTOR } from "./monitoring/radar-page-inspector.js";
import { RADAR_PORT, type RadarPort } from "./radar.port.js";
import { OIDC_TOKEN_VERIFIER, OidcTokenVerificationError } from "./auth/oidc-token-verifier.js";

const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1_000;

/** A Moscow wall-clock instant `days` days ahead of the current Moscow day. */
function moscowDateInDays(days: number, hour: number): { command: string; utc: string } {
  const moscowNow = new Date(Date.now() + MOSCOW_UTC_OFFSET_MS);
  const instant = new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate() + days,
      hour,
    ) - MOSCOW_UTC_OFFSET_MS,
  );
  const local = new Date(instant.getTime() + MOSCOW_UTC_OFFSET_MS);
  return { command: `${local.toISOString().slice(0, 19)}+03:00`, utc: instant.toISOString() };
}

interface SeededContactRef {
  id: string;
  fullName: string;
  role: string;
  department: string | null;
}

interface SeededActionRef {
  taskId: string;
  organizationId: string;
  opportunityId: string;
  contacts: SeededContactRef[];
}

describe("Today HTTP contract", () => {
  let app: INestApplication;
  /** Seeded fixture rows keyed by organization name — ids differ per persistence mode. */
  const seeded = new Map<string, SeededActionRef>();
  let currentUserId: string;
  let sharedContactId: string;

  function seededAction(organizationName: string): SeededActionRef {
    const action = seeded.get(organizationName);
    if (!action) throw new Error(`Seeded action for «${organizationName}» not found`);
    return action;
  }

  async function refreshSeededActions() {
    const today = await request(app.getHttpServer()).get("/api/v1/today").expect(200);
    currentUserId = today.body.currentUser.id;
    for (const action of today.body.actions as Array<
      SeededContactRef & {
        id: string;
        organizationId: string;
        organizationName: string;
        opportunityId: string;
        contacts: SeededContactRef[];
      }
    >) {
      seeded.set(action.organizationName, {
        taskId: action.id,
        organizationId: action.organizationId,
        opportunityId: action.opportunityId,
        contacts: action.contacts,
      });
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RADAR_INSPECTOR)
      .useValue({
        inspect: async (pageUrl: string) => ({
          pageUrl,
          status: "found",
          playerType: "RUTUBE",
          detectedAt: new Date("2026-08-18T10:00:00.000Z"),
          method: "l0-html",
          confidence: "high",
          httpStatus: 200,
          playerFound: true,
          embedUrl: "https://rutube.ru/play/embed/video-id",
          errorCode: null,
          featureExtraction: {
            features: {},
            research: {
              method: "html-signals-v1",
              decisionMakers: [
                {
                  fullName: "Мария Иванова",
                  role: "Коммерческий директор",
                  department: "Коммерческий отдел",
                  email: "m.ivanova@new-media.example",
                  phone: null,
                  profileUrl: null,
                  sourceUrl: pageUrl,
                  evidence: "Мария Иванова — коммерческий директор",
                  confidence: "high",
                },
              ],
              pageUrl,
              collectedAt: "2026-08-18T10:00:00.000Z",
              signals: [],
              contacts: [
                {
                  type: "email",
                  value: "editor@new-media.example",
                  href: "mailto:editor@new-media.example",
                  sourceUrl: pageUrl,
                  confidence: "high",
                },
              ],
              videoPages: [
                {
                  pageUrl,
                  label: "Видеоновости",
                  sourceUrl: pageUrl,
                  confidence: "medium",
                },
              ],
              brief: {
                readiness: "ready_for_outreach",
                siteSummary: "Новостная площадка из России.",
                videoUsage: "На странице найден RUTUBE-плеер.",
                rutubeUseCase: "видеоновости и репортажи в RUTUBE-плеере",
                likelyContactRoles: ["Видеоредакция", "Коммерческий отдел"],
                risks: ["Трафик не подтверждён внешним провайдером."],
                nextAction: "Связаться с Марией Ивановой через m.ivanova@new-media.example.",
              },
              notes: [],
            },
          },
        }),
      })
      .overrideProvider(OIDC_TOKEN_VERIFIER)
      .useValue({
        verify: async (token: string) => {
          if (token !== "integration.signed.token") throw new OidcTokenVerificationError();
          return "bootstrap:anna.sokolova";
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, "127.0.0.1");
    await refreshSeededActions();
    const shared = seededAction("Медиа Новости").contacts[0];
    if (!shared) throw new Error("Seeded shared contact not found");
    sharedContactId = shared.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("resolves controller dependencies and returns the Today payload", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/today").expect(200);

    expect(response.body.summary).toMatchObject({ critical: 3, today: 7, waiting: 4 });
    expect(response.body.actions[0]).toMatchObject({
      organizationName: "Медиа Новости",
      priorityScore: 92,
      contacts: [
        expect.objectContaining({
          id: sharedContactId,
          fullName: "Иван Петров",
        }),
      ],
    });
    const sharedContactLinks = response.body.actions
      .filter((action: { organizationName: string }) =>
        ["Медиа Новости", "Спорт Онлайн"].includes(action.organizationName),
      )
      .map(
        (action: { organizationName: string; contacts: Array<{ id: string; role: string }> }) => ({
          organizationName: action.organizationName,
          ...action.contacts[0],
        }),
      );
    expect(sharedContactLinks).toEqual([
      expect.objectContaining({
        organizationName: "Медиа Новости",
        id: sharedContactId,
        role: "Технический директор",
      }),
      expect.objectContaining({
        organizationName: "Спорт Онлайн",
        id: sharedContactId,
        role: "Консультант по интеграции",
      }),
    ]);
  });

  it("returns the verified session and blocks observer mutations", async () => {
    const session = await request(app.getHttpServer()).get("/api/v1/session").expect(200);
    expect(session.body).toMatchObject({
      subject: "bootstrap:anna.sokolova",
      displayName: "Анна Соколова",
      role: "admin",
      scope: { mode: "all", teamName: "Команда внедрения" },
    });
    expect(session.body.permissions).toContain("partners.export");

    await request(app.getHttpServer())
      .get("/api/v1/today")
      .set("X-Embed-Actor", "bootstrap:observer")
      .expect(200);

    const denied = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${seededAction("Travel Guide").taskId}/reschedule`)
      .set("X-Embed-Actor", "bootstrap:observer")
      .set("Idempotency-Key", "observer-mutation-must-be-denied")
      .send({
        dueAt: "2026-08-27T12:00:00+03:00",
        reason: "Эта команда не должна выполниться",
      })
      .expect(403);
    expect(denied.body).toMatchObject({
      code: "ACCESS_PERMISSION_DENIED",
      detail: "Нет разрешения tasks.write",
    });
  });

  it("lets only an administrator manage versioned user access idempotently", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/settings/access/users")
      .set("X-Embed-Actor", "bootstrap:observer")
      .expect(403);

    const matrix = await request(app.getHttpServer())
      .get("/api/v1/settings/access/users")
      .expect(200);
    expect(matrix.body.users).toHaveLength(5);
    expect(matrix.body.teams).toHaveLength(1);
    expect(matrix.body.roles).toContain("technical_specialist");
    const created = await request(app.getHttpServer())
      .post("/api/v1/settings/access/users")
      .set("Idempotency-Key", "integration-access-user-create-0001")
      .send({
        subject: "oidc:pilot.user",
        displayName: "Пилотный Пользователь",
        email: "pilot.user@example.test",
        teamId: matrix.body.teams[0].id,
        role: "observer",
        permissions: ["today.read", "partners.read"],
        reason: "Регистрация участника пилота",
      })
      .expect(201);
    expect(created.body).toMatchObject({
      subject: "oidc:pilot.user",
      role: "observer",
      version: 1,
    });
    await request(app.getHttpServer())
      .get("/api/v1/session")
      .set("X-Embed-Actor", "oidc:pilot.user")
      .expect(200);
    const manager = matrix.body.users.find(
      (user: { subject: string }) => user.subject === "bootstrap:sergey.volkov",
    );
    const command = {
      version: manager.version,
      status: "active",
      role: "analyst",
      permissions: ["today.read", "partners.read", "reports.view", "reports.generate"],
      reason: "Перевод пользователя в аналитическую команду",
    };
    const first = await request(app.getHttpServer())
      .patch(`/api/v1/settings/access/users/${manager.id}`)
      .set("Idempotency-Key", "integration-access-user-update-0001")
      .send(command)
      .expect(200);
    const replay = await request(app.getHttpServer())
      .patch(`/api/v1/settings/access/users/${manager.id}`)
      .set("Idempotency-Key", "integration-access-user-update-0001")
      .send(command)
      .expect(200);
    expect(first.body).toMatchObject({ role: "analyst", version: manager.version + 1 });
    expect(replay.body).toEqual(first.body);

    const changedSession = await request(app.getHttpServer())
      .get("/api/v1/session")
      .set("X-Embed-Actor", "bootstrap:sergey.volkov")
      .expect(200);
    expect(changedSession.body).toMatchObject({ role: "analyst" });

    const admin = matrix.body.users.find((user: { currentUser: boolean }) => user.currentUser);
    const selfDenied = await request(app.getHttpServer())
      .patch(`/api/v1/settings/access/users/${admin.id}`)
      .set("Idempotency-Key", "integration-access-self-update-0001")
      .send({
        version: admin.version,
        status: "inactive",
        role: "observer",
        permissions: ["today.read"],
        reason: "Проверка защиты от самостоятельной блокировки",
      })
      .expect(422);
    expect(selfDenied.body.code).toBe("ACCESS_SELF_MODIFICATION");
  });

  it("ignores a spoofed actor header and requires a verified Bearer token in oidc_jwt mode", async () => {
    const previousMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "oidc_jwt";
    try {
      await request(app.getHttpServer())
        .get("/api/v1/session")
        .set("X-Embed-Actor", "bootstrap:anna.sokolova")
        .expect(401);

      await request(app.getHttpServer())
        .get("/api/v1/session")
        .set("Authorization", "Bearer invalid.signed.token")
        .expect(401);

      const verified = await request(app.getHttpServer())
        .get("/api/v1/session")
        .set("Authorization", "Bearer integration.signed.token")
        .set("X-Embed-Actor", "bootstrap:observer")
        .expect(200);
      expect(verified.body).toMatchObject({
        subject: "bootstrap:anna.sokolova",
        role: "admin",
      });
    } finally {
      if (previousMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousMode;
    }
  });

  it("lets only an administrator publish versioned SLA thresholds idempotently", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/settings/sla")
      .set("X-Embed-Actor", "bootstrap:observer")
      .expect(403);

    const current = await request(app.getHttpServer()).get("/api/v1/settings/sla").expect(200);
    expect(current.body).toMatchObject({
      version: 1,
      escalationAfterDays: 3,
      affectedOpportunities: 16,
    });
    expect(current.body.stages).toHaveLength(11);

    const command = {
      version: current.body.version,
      escalationAfterDays: 4,
      thresholds: {
        S0: 2,
        S1: 2,
        S2: 3,
        S3: 3,
        S4: 6,
        S5: 5,
        S6: 5,
        S7: 7,
        S8: 7,
        S9: 14,
        S10: 14,
      },
      reason: "Увеличили срок диалога после пилотной недели",
    };
    const first = await request(app.getHttpServer())
      .patch("/api/v1/settings/sla")
      .set("Idempotency-Key", "test-key-sla-settings-publish-0001")
      .send(command)
      .expect(200);
    const replay = await request(app.getHttpServer())
      .patch("/api/v1/settings/sla")
      .set("Idempotency-Key", "test-key-sla-settings-publish-0001")
      .send(command)
      .expect(200);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({ version: 2, escalationAfterDays: 4 });
    expect(first.body.stages).toContainEqual(
      expect.objectContaining({
        code: "S4",
        thresholdDays: 6,
      }),
    );

    const stale = await request(app.getHttpServer())
      .patch("/api/v1/settings/sla")
      .set("Idempotency-Key", "test-key-sla-settings-publish-0002")
      .send(command)
      .expect(409);
    expect(stale.body).toMatchObject({
      code: "SLA_SETTINGS_VERSION_CONFLICT",
      currentVersion: 2,
    });
  });

  it("reschedules a task idempotently and requires an explicit reason", async () => {
    const taskId = seededAction("Travel Guide").taskId;
    const rescheduleTo = moscowDateInDays(8, 12);
    await request(app.getHttpServer())
      .post(`/api/v1/tasks/${taskId}/reschedule`)
      .set("Idempotency-Key", "test-key-http-reschedule-invalid-0001")
      .send({ dueAt: rescheduleTo.command })
      .expect(422);

    const command = {
      dueAt: rescheduleTo.command,
      reason: "Партнёр перенёс встречу",
    };
    const first = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${taskId}/reschedule`)
      .set("Idempotency-Key", "test-key-http-reschedule-0001")
      .send(command)
      .expect(200);
    expect(first.body.actions).toContainEqual(
      expect.objectContaining({
        id: taskId,
        dueAt: rescheduleTo.utc,
        group: "later",
      }),
    );

    const replay = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${taskId}/reschedule`)
      .set("Idempotency-Key", "test-key-http-reschedule-0001")
      .send(command)
      .expect(200);
    expect(replay.body.summary.rescheduled).toBe(first.body.summary.rescheduled);

    await request(app.getHttpServer())
      .post(`/api/v1/tasks/${taskId}/reschedule`)
      .set("Idempotency-Key", "test-key-http-reschedule-0001")
      .send({ ...command, dueAt: moscowDateInDays(9, 12).command })
      .expect(409);
  });

  it("returns the funnel dataset used by kanban and table views", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/opportunities").expect(200);

    // The SLA settings test above published ProcessDefinition v2, which
    // migrates every open opportunity onto the new version (baseline rule).
    expect(response.body).toMatchObject({
      teamName: "Команда внедрения",
      total: 16,
      truncated: false,
      processVersions: [2],
    });
    expect(
      response.body.stageCounts.reduce(
        (sum: number, stage: { count: number }) => sum + stage.count,
        0,
      ),
    ).toBe(16);
    expect(response.body.opportunities).toContainEqual(
      expect.objectContaining({
        id: seededAction("Медиа Новости").opportunityId,
        organizationName: "Медиа Новости",
        stageCode: "S7",
        owner: { id: currentUserId, name: "Анна Соколова" },
      }),
    );
  });

  it("filters organizations and returns the unified partner card", async () => {
    const registry = await request(app.getHttpServer())
      .get("/api/v1/partners?stageCode=S7&scoreMin=80")
      .expect(200);

    expect(registry.body).toMatchObject({
      teamName: "Команда внедрения",
      total: 3,
      truncated: false,
    });
    const media = seededAction("Медиа Новости");
    expect(registry.body.partners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: media.organizationId,
          name: "Медиа Новости",
          primaryDomain: "medianovosti.ru",
          partnerScore: 85,
          currentStage: { code: "S7", label: "Интеграция" },
        }),
        expect.objectContaining({
          id: seededAction("Спорт Онлайн").organizationId,
          name: "Спорт Онлайн",
          partnerScore: 90,
        }),
      ]),
    );

    const card = await request(app.getHttpServer())
      .get(`/api/v1/partners/${media.organizationId}`)
      .expect(200);
    expect(card.body).toMatchObject({
      organization: expect.objectContaining({
        id: media.organizationId,
        name: "Медиа Новости",
      }),
      contacts: [expect.objectContaining({ fullName: "Иван Петров" })],
      opportunities: [expect.objectContaining({ id: media.opportunityId, stageCode: "S7" })],
      tasks: [expect.objectContaining({ id: media.taskId, status: "OPEN" })],
      documents: [],
    });
    expect(card.body.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "partner_score", value: 85 })]),
    );
  });

  it("groups brands, legal entities and domains in one organization group", async () => {
    const media = seededAction("Медиа Новости");
    const city = seededAction("Городской портал");
    const card = await request(app.getHttpServer())
      .get(`/api/v1/partners/${media.organizationId}`)
      .expect(200);
    expect(card.body.organizationGroup).toMatchObject({
      name: "Медиа Альянс",
      members: expect.arrayContaining([
        expect.objectContaining({ id: media.organizationId, name: "Медиа Новости" }),
        expect.objectContaining({ id: city.organizationId, name: "Городской портал" }),
      ]),
    });
    expect(card.body.organizationGroup.members[0]).toHaveProperty("domains");
    const groupId: string = card.body.organizationGroup.id;

    const registry = await request(app.getHttpServer())
      .get(`/api/v1/partners?groupId=${groupId}`)
      .expect(200);

    expect(registry.body).toMatchObject({
      total: 2,
      filters: {
        groups: [expect.objectContaining({ id: groupId, name: "Медиа Альянс" })],
      },
    });
    expect(registry.body.partners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: media.organizationId,
          organizationGroup: { id: groupId, name: "Медиа Альянс" },
        }),
        expect.objectContaining({
          id: city.organizationId,
          organizationGroup: { id: groupId, name: "Медиа Альянс" },
        }),
      ]),
    );
  });

  it("exports partners only with a separate permission and records immutable audit", async () => {
    const forbidden = await request(app.getHttpServer())
      .post("/api/v1/partners/exports")
      .set("X-Embed-Actor", "bootstrap:observer")
      .send({ scoreMin: 80 })
      .expect(403);
    expect(forbidden.body).toMatchObject({ code: "ACCESS_PERMISSION_DENIED" });

    const exported = await request(app.getHttpServer())
      .post("/api/v1/partners/exports")
      .set("X-Embed-Actor", "bootstrap:anna.sokolova")
      .send({ scoreMin: 80 })
      .expect(200);
    expect(exported.headers["content-type"]).toContain("text/csv");
    expect(exported.headers["cache-control"]).toBe("no-store");
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(exported.headers["x-export-audit-id"]).toBeTruthy();
    expect(exported.text).toContain("Медиа Новости");
    expect(exported.text).not.toContain("Городской портал");

    const audit = await request(app.getHttpServer())
      .get("/api/v1/partners/exports/audit")
      .set("X-Embed-Actor", "bootstrap:anna.sokolova")
      .expect(200);
    expect(audit.body).toContainEqual(
      expect.objectContaining({
        id: exported.headers["x-export-audit-id"],
        actorSubject: "bootstrap:anna.sokolova",
        permission: "partners.export",
        rowCount: 4,
      }),
    );
  });

  it("previews and cancels an organization CSV import without applying rows", async () => {
    const preview = await request(app.getHttpServer())
      .post("/api/v1/imports/organizations/preview")
      .attach(
        "file",
        Buffer.from(
          [
            "organization_name,domain,source",
            "Новый партнёр,new-partner.ru,Пилот",
            "Медиа Новости,another-media.ru,Таблица",
          ].join("\n"),
          "utf8",
        ),
        "partners.csv",
      )
      .expect(201);

    expect(preview.body).toMatchObject({
      fileName: "partners.csv",
      format: "csv",
      status: "preview",
      summary: { total: 2, create: 1, conflict: 1, applied: 0 },
    });
    const cancelled = await request(app.getHttpServer())
      .post(`/api/v1/imports/organizations/${preview.body.id}/cancel`)
      .set("Idempotency-Key", "test-key-import-cancel-0001")
      .expect(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", completedAt: expect.any(String) });
    expect(
      cancelled.body.rows.every((row: { entityId: string | null }) => row.entityId === null),
    ).toBe(true);
  });

  it("registers and lists a placement idempotently", async () => {
    const media = seededAction("Медиа Новости");
    const command = {
      organizationId: media.organizationId,
      opportunityId: media.opportunityId,
      pageUrl: "https://medianovosti.ru/articles/rutube-player",
      embedType: "video",
      environment: "production",
      businessStatus: "active",
      launchedAt: "2026-08-18T08:00:00+03:00",
    };
    const first = await request(app.getHttpServer())
      .post("/api/v1/placements")
      .set("Idempotency-Key", "test-key-placement-register-0001")
      .send(command)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post("/api/v1/placements")
      .set("Idempotency-Key", "test-key-placement-register-0001")
      .send(command)
      .expect(201);

    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      organizationName: "Медиа Новости",
      healthStatus: "unchecked",
      businessStatus: "active",
    });
    const list = await request(app.getHttpServer()).get("/api/v1/placements").expect(200);
    expect(list.body).toContainEqual(first.body);
  });

  it("updates and archives a placement with version conflict protection", async () => {
    const media = seededAction("Медиа Новости");
    const created = await request(app.getHttpServer())
      .post("/api/v1/placements")
      .set("Idempotency-Key", "test-key-placement-lifecycle-register-0001")
      .send({
        organizationId: media.organizationId,
        opportunityId: media.opportunityId,
        pageUrl: "https://medianovosti.ru/articles/lifecycle",
        embedType: "video",
        environment: "production",
        businessStatus: "active",
        launchedAt: "2026-08-18T08:00:00+03:00",
      })
      .expect(201);

    const paused = await request(app.getHttpServer())
      .patch(`/api/v1/placements/${created.body.id}`)
      .set("Idempotency-Key", "test-key-placement-lifecycle-update-0001")
      .send({
        version: created.body.version,
        businessStatus: "paused",
        reason: "Пауза по запросу партнёра",
      })
      .expect(200);
    expect(paused.body).toMatchObject({ businessStatus: "paused", nextCheckAt: null, version: 2 });

    const conflict = await request(app.getHttpServer())
      .patch(`/api/v1/placements/${created.body.id}`)
      .set("Idempotency-Key", "test-key-placement-lifecycle-update-0002")
      .send({ version: 1, businessStatus: "ended", reason: "Устаревшая форма" })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: "PLACEMENT_VERSION_CONFLICT",
      currentVersion: 2,
    });

    await request(app.getHttpServer())
      .post(`/api/v1/placements/${created.body.id}/archive`)
      .set("Idempotency-Key", "test-key-placement-lifecycle-archive-0001")
      .send({ version: paused.body.version, reason: "Размещение демонтировано" })
      .expect(200);
    const list = await request(app.getHttpServer()).get("/api/v1/placements").expect(200);
    expect(list.body.some((placement: { id: string }) => placement.id === created.body.id)).toBe(
      false,
    );
  });

  it("classifies a loopback L0 target as blocked without requesting it", async () => {
    const sport = seededAction("Спорт Онлайн");
    const placement = await request(app.getHttpServer())
      .post("/api/v1/placements")
      .set("Idempotency-Key", "test-key-placement-private-0001")
      .send({
        organizationId: sport.organizationId,
        opportunityId: sport.opportunityId,
        pageUrl: "http://127.0.0.1/internal-player",
        embedType: "video",
        environment: "test",
        businessStatus: "active",
        launchedAt: "2026-08-18T08:00:00+03:00",
      })
      .expect(201);

    const first = await request(app.getHttpServer())
      .post(`/api/v1/placements/${placement.body.id}/l0-checks`)
      .set("Idempotency-Key", "test-key-placement-check-private-0001")
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/placements/${placement.body.id}/l0-checks`)
      .set("Idempotency-Key", "test-key-placement-check-private-0001")
      .expect(201);

    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      alertChange: "none",
      check: { result: "blocked", errorCode: "NETWORK_TARGET_BLOCKED" },
      placement: { healthStatus: "degraded", consecutiveFailures: 0 },
    });
  });

  it("transitions an opportunity idempotently and enforces BR-007", async () => {
    const opportunityId = seededAction("Кинообзор").opportunityId;
    const command = { version: 1, toStageCode: "S8", reason: "Пилот согласован" };
    const first = await request(app.getHttpServer())
      .post(`/api/v1/opportunities/${opportunityId}/stage-transitions`)
      .set("Idempotency-Key", "test-key-stage-transition-0001")
      .send(command)
      .expect(200);
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/opportunities/${opportunityId}/stage-transitions`)
      .set("Idempotency-Key", "test-key-stage-transition-0001")
      .send(command)
      .expect(200);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({ fromStageCode: "S7", toStageCode: "S8", version: 2 });

    const conflict = await request(app.getHttpServer())
      .post(`/api/v1/opportunities/${opportunityId}/stage-transitions`)
      .set("Idempotency-Key", "test-key-stage-transition-stale-0001")
      .send({ version: 1, toStageCode: "S9", reason: "Устаревшая форма" })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: "OPPORTUNITY_VERSION_CONFLICT",
      currentVersion: 2,
    });

    const blocked = await request(app.getHttpServer())
      .post(`/api/v1/opportunities/${opportunityId}/stage-transitions`)
      .set("Idempotency-Key", "test-key-stage-transition-0002")
      .send({ version: 2, toStageCode: "S9", reason: "Запуск без проверки" })
      .expect(422);
    expect(blocked.body).toMatchObject({
      code: "BR-007",
      fieldErrors: {
        activePlacement: expect.any(String),
        launchedAt: expect.any(String),
        monitoring: expect.any(String),
        responsible: expect.any(String),
      },
    });
  });

  it("lists the exact BR-003 field missing from a stage transition", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/opportunities/${seededAction("EduVideo").opportunityId}/stage-transitions`)
      .set("Idempotency-Key", "test-key-stage-required-0001")
      .send({ version: 1, toStageCode: "S3", reason: "Первичное письмо отправлено" })
      .expect(422);

    expect(response.body).toMatchObject({
      code: "BR-003",
      fieldErrors: {
        interactionOutcome: "Зафиксируйте результат контакта",
      },
    });
  });

  it("returns problem+json when BR-002 is violated", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${seededAction("Медиа Новости").taskId}/complete`)
      .set("Idempotency-Key", "test-key-br002-0001")
      .send({ outcome: "Готово" })
      .expect(422);

    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({ code: "BR-002", status: 422 });
  });

  it("requires Idempotency-Key for mutations", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${seededAction("Медиа Новости").taskId}/complete`)
      .send({
        contactId: sharedContactId,
        interactionType: "call",
        outcome: "Получен ответ",
        summary: "Партнёр прислал спецификацию",
        next: {
          mode: "task",
          title: "Отправить примеры",
          dueAt: "2026-08-18T12:00:00+03:00",
        },
      })
      .expect(400);

    expect(response.body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      status: 400,
    });
  });

  it("rejects a system interaction type from the manual contact command", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${seededAction("Спорт Онлайн").taskId}/complete`)
      .set("Idempotency-Key", "test-key-invalid-interaction-0001")
      .send({
        contactId: sharedContactId,
        interactionType: "system-event",
        outcome: "Получен ответ",
        summary: "Партнёр прислал спецификацию",
        next: {
          mode: "task",
          title: "Подготовить ответ",
          dueAt: "2026-08-18T12:00:00+03:00",
        },
      })
      .expect(422);

    expect(response.body).toMatchObject({ code: "TSK-008", status: 422 });
  });

  it("requires a contact for a manual interaction", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${seededAction("Кинообзор").taskId}/complete`)
      .set("Idempotency-Key", "test-key-contact-required-0001")
      .send({
        interactionType: "email",
        outcome: "Получен ответ",
        summary: "Партнёр прислал спецификацию",
        next: {
          mode: "task",
          title: "Подготовить ответ",
          dueAt: "2026-08-18T12:00:00+03:00",
        },
      })
      .expect(422);

    expect(response.body).toMatchObject({
      code: "TSK-008",
      status: 422,
      fieldErrors: { contactId: expect.any(String) },
    });
  });

  it("rejects a contact linked to another organization", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${seededAction("Городской портал").taskId}/complete`)
      .set("Idempotency-Key", "test-key-contact-scope-0001")
      .send({
        contactId: sharedContactId,
        interactionType: "call",
        outcome: "Получен ответ",
        summary: "Попытка сохранить чужой контакт",
        next: {
          mode: "task",
          title: "Уточнить контакт",
          dueAt: "2026-08-18T12:00:00+03:00",
        },
      })
      .expect(422);

    expect(response.body).toMatchObject({
      code: "CONTACT_NOT_AVAILABLE",
      status: 422,
      fieldErrors: { contactId: expect.any(String) },
    });
  });

  it("creates a normalized contact idempotently and blocks an exact duplicate", async () => {
    const techBlog = seededAction("TechBlog");
    const command = {
      fullName: "  Мария Орлова  ",
      role: " Редактор ",
      department: " Контент ",
      email: " MARIA.ORLOVA@EXAMPLE.RU ",
      phone: "8 (999) 123-45-67",
      messenger: " Maria_Orlova ",
      restrictions: " Только рабочее время ",
    };
    const first = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${techBlog.organizationId}/contacts`)
      .set("Idempotency-Key", "test-key-create-contact-0001")
      .send(command)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${techBlog.organizationId}/contacts`)
      .set("Idempotency-Key", "test-key-create-contact-0001")
      .send(command)
      .expect(201);

    expect(first.body).toMatchObject({
      fullName: "Мария Орлова",
      role: "Редактор",
      department: "Контент",
      email: "maria.orlova@example.ru",
      phone: "+79991234567",
      messenger: "@maria_orlova",
      isPrimary: false,
    });
    expect(replay.body).toEqual(first.body);

    const today = await request(app.getHttpServer()).get("/api/v1/today").expect(200);
    expect(
      today.body.actions.find((action: { id: string }) => action.id === techBlog.taskId).contacts,
    ).toContainEqual(first.body);

    const duplicate = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${techBlog.organizationId}/contacts`)
      .set("Idempotency-Key", "test-key-create-contact-0002")
      .send({
        fullName: "Другая Мария",
        role: "Редактор",
        email: "maria.orlova@example.ru",
      })
      .expect(409);
    expect(duplicate.body).toMatchObject({
      code: "CONTACT_DUPLICATE_CANDIDATES",
      status: 409,
      duplicateCandidates: [
        expect.objectContaining({ id: first.body.id, isLinkedToOrganization: true }),
      ],
    });
  });

  it("lists, updates, archives and restores a contact with optimistic locking", async () => {
    const lifestyle = seededAction("LifeStyle Media");
    const created = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${lifestyle.organizationId}/contacts`)
      .set("Idempotency-Key", "test-key-contact-registry-create-0001")
      .send({
        fullName: "Елена Соколова",
        role: "Коммерческий директор",
        department: "Развитие",
        email: "elena.registry@example.ru",
        source: "Конференция",
        verifiedAt: "2026-08-18T12:00:00+03:00",
        restrictions: "Только рабочая почта",
      })
      .expect(201);

    const registry = await request(app.getHttpServer())
      .get("/api/v1/contacts?search=elena.registry")
      .expect(200);
    const contact = registry.body.contacts.find(({ id }: { id: string }) => id === created.body.id);
    expect(contact).toMatchObject({
      version: 1,
      fullName: "Елена Соколова",
      source: "Конференция",
      verifiedAt: "2026-08-18T09:00:00.000Z",
      restrictions: "Только рабочая почта",
      status: "active",
      organizationLinks: [
        expect.objectContaining({
          organizationId: lifestyle.organizationId,
          role: "Коммерческий директор",
        }),
      ],
    });

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/contacts/${created.body.id}`)
      .set("Idempotency-Key", "test-key-contact-registry-update-0001")
      .send({
        version: 1,
        fullName: "Елена Соколова",
        email: "elena.registry@example.ru",
        messenger: "elena_registry",
        source: "Личная встреча",
        verifiedAt: "2026-08-18T13:00:00+03:00",
        restrictions: "Без звонков",
        organizationLink: {
          id: contact.organizationLinks[0].id,
          role: "Директор по партнёрствам",
          department: "Развитие бизнеса",
        },
      })
      .expect(200);
    expect(updated.body).toMatchObject({
      version: 2,
      source: "Личная встреча",
      messenger: "@elena_registry",
      organizationLinks: [expect.objectContaining({ role: "Директор по партнёрствам" })],
    });

    const stale = await request(app.getHttpServer())
      .patch(`/api/v1/contacts/${created.body.id}`)
      .set("Idempotency-Key", "test-key-contact-registry-update-stale-0001")
      .send({
        version: 1,
        fullName: "Елена Соколова",
        email: "elena.registry@example.ru",
        source: "Устаревшая форма",
      })
      .expect(409);
    expect(stale.body).toMatchObject({ code: "CONTACT_VERSION_CONFLICT", currentVersion: 2 });

    const archived = await request(app.getHttpServer())
      .post(`/api/v1/contacts/${created.body.id}/archive`)
      .set("Idempotency-Key", "test-key-contact-registry-archive-0001")
      .send({ version: 2, reason: "Контакт больше не работает в компании" })
      .expect(200);
    expect(archived.body).toMatchObject({
      version: 3,
      status: "archived",
      archivedAt: expect.any(String),
    });
    const todayWithoutArchived = await request(app.getHttpServer())
      .get("/api/v1/today")
      .expect(200);
    expect(
      todayWithoutArchived.body.actions.find(({ id }: { id: string }) => id === lifestyle.taskId)
        .contacts,
    ).not.toContainEqual(expect.objectContaining({ id: created.body.id }));

    const restored = await request(app.getHttpServer())
      .post(`/api/v1/contacts/${created.body.id}/restore`)
      .set("Idempotency-Key", "test-key-contact-registry-restore-0001")
      .send({ version: 3, reason: "Контакт снова подтверждён" })
      .expect(200);
    expect(restored.body).toMatchObject({ version: 4, status: "active", archivedAt: null });
  });

  it("links an existing contact to another organization with a contextual role", async () => {
    const autoPortal = seededAction("АвтоПортал");
    const regions = seededAction("Новости Регионов");
    const created = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${autoPortal.organizationId}/contacts`)
      .set("Idempotency-Key", "test-key-link-source-0001")
      .send({
        fullName: "Алексей Воронцов",
        role: "Технический директор",
        email: "alexey.link@example.ru",
      })
      .expect(201);
    const command = { role: " Технический эксперт ", department: " ИТ " };

    const first = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${regions.organizationId}/contacts/${created.body.id}/link`)
      .set("Idempotency-Key", "test-key-link-contact-0001")
      .send(command)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${regions.organizationId}/contacts/${created.body.id}/link`)
      .set("Idempotency-Key", "test-key-link-contact-0001")
      .send(command)
      .expect(201);

    expect(first.body).toMatchObject({
      id: created.body.id,
      fullName: "Алексей Воронцов",
      role: "Технический эксперт",
      department: "ИТ",
      email: "alexey.link@example.ru",
      isPrimary: false,
    });
    expect(replay.body).toEqual(first.body);

    const today = await request(app.getHttpServer()).get("/api/v1/today").expect(200);
    expect(
      today.body.actions.find((action: { id: string }) => action.id === regions.taskId).contacts,
    ).toContainEqual(first.body);

    const alreadyLinked = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${regions.organizationId}/contacts/${created.body.id}/link`)
      .set("Idempotency-Key", "test-key-link-contact-0002")
      .send(command)
      .expect(409);
    expect(alreadyLinked.body).toMatchObject({
      code: "CONTACT_ALREADY_LINKED",
      status: 409,
    });

    const missing = await request(app.getHttpServer())
      .post(
        `/api/v1/organizations/${regions.organizationId}/contacts/00000000-0000-4000-8000-999999999999/link`,
      )
      .set("Idempotency-Key", "test-key-link-contact-missing-0001")
      .send(command)
      .expect(404);
    expect(missing.body).toMatchObject({ code: "CONTACT_NOT_FOUND", status: 404 });
  });

  it("merges a duplicate contact idempotently and preserves its organization context", async () => {
    const kino = seededAction("Кинообзор");
    const sourceContactId = kino.contacts[0]?.id;
    if (!sourceContactId) throw new Error("Seeded contact for «Кинообзор» not found");
    const command = {
      targetContactId: ` ${sharedContactId} `,
      reason: " Совпадает подтверждённый рабочий контакт ",
    };
    const first = await request(app.getHttpServer())
      .post(`/api/v1/contacts/${sourceContactId}/merge`)
      .set("Idempotency-Key", "test-key-merge-contact-0001")
      .send(command)
      .expect(200);
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/contacts/${sourceContactId}/merge`)
      .set("Idempotency-Key", "test-key-merge-contact-0001")
      .send(command)
      .expect(200);

    expect(first.body).toMatchObject({
      sourceContactId,
      targetContactId: sharedContactId,
      movedOrganizationLinks: 1,
      closedConflictingLinks: 0,
      movedInteractions: 0,
      outboxEventId: expect.any(String),
    });
    expect(replay.body).toEqual(first.body);

    const today = await request(app.getHttpServer()).get("/api/v1/today").expect(200);
    const contacts = today.body.actions.find(
      (action: { id: string }) => action.id === kino.taskId,
    ).contacts;
    expect(contacts).toContainEqual(
      expect.objectContaining({
        id: sharedContactId,
        role: "Технический руководитель",
        department: "ИТ",
      }),
    );
    expect(contacts).not.toContainEqual(expect.objectContaining({ id: sourceContactId }));

    const alreadyMerged = await request(app.getHttpServer())
      .post(`/api/v1/contacts/${sourceContactId}/merge`)
      .set("Idempotency-Key", "test-key-merge-contact-0002")
      .send(command)
      .expect(409);
    expect(alreadyMerged.body).toMatchObject({
      code: "CONTACT_ALREADY_MERGED",
      status: 409,
    });
  });

  it("closes the duplicate organization link when both contacts are already linked", async () => {
    const edu = seededAction("EduVideo");
    const source = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${edu.organizationId}/contacts`)
      .set("Idempotency-Key", "test-key-merge-conflict-source-0001")
      .send({
        fullName: "Ольга Сергеева",
        role: "Редактор",
        email: "olga.merge.source@example.ru",
      })
      .expect(201);
    const target = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${edu.organizationId}/contacts`)
      .set("Idempotency-Key", "test-key-merge-conflict-target-0001")
      .send({
        fullName: "Ольга Сергеева",
        role: "Главный редактор",
        email: "olga.merge.target@example.ru",
      })
      .expect(201);

    const merged = await request(app.getHttpServer())
      .post(`/api/v1/contacts/${source.body.id}/merge`)
      .set("Idempotency-Key", "test-key-merge-conflict-0001")
      .send({ targetContactId: target.body.id, reason: "Подтверждено владельцем данных" })
      .expect(200);

    expect(merged.body).toMatchObject({
      movedOrganizationLinks: 0,
      closedConflictingLinks: 1,
    });
    const today = await request(app.getHttpServer()).get("/api/v1/today").expect(200);
    const contacts = today.body.actions.find(
      (action: { id: string }) => action.id === edu.taskId,
    ).contacts;
    expect(contacts.filter(({ id }: { id: string }) => id === target.body.id)).toHaveLength(1);
    expect(contacts.some(({ id }: { id: string }) => id === source.body.id)).toBe(false);
  });

  it("rejects merging a contact into itself", async () => {
    const contactId = seededAction("Деловой обзор").contacts[0]?.id;
    if (!contactId) throw new Error("Seeded contact for «Деловой обзор» not found");
    const response = await request(app.getHttpServer())
      .post(`/api/v1/contacts/${contactId}/merge`)
      .set("Idempotency-Key", "test-key-merge-self-0001")
      .send({ targetContactId: contactId, reason: "Ошибка оператора" })
      .expect(422);

    expect(response.body).toMatchObject({
      code: "CONTACT_MERGE_SAME_CONTACT",
      status: 422,
    });
  });

  it("replays the same mutation and rejects a changed payload", async () => {
    const taskId = seededAction("Медиа Новости").taskId;
    const command = {
      contactId: sharedContactId,
      interactionType: "email",
      outcome: "Получен ответ",
      summary: "Партнёр прислал спецификацию",
      next: {
        mode: "task",
        title: "Отправить примеры",
        dueAt: "2026-08-18T12:00:00+03:00",
      },
    };
    const first = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${taskId}/complete`)
      .set("Idempotency-Key", "test-key-http-replay-0001")
      .send(command)
      .expect(200);
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${taskId}/complete`)
      .set("Idempotency-Key", "test-key-http-replay-0001")
      .send(command)
      .expect(200);

    expect(replay.body).toEqual(first.body);
    expect(replay.body.summary.completed).toBe(7);
    expect(
      replay.body.actions.find((action: { title: string }) => action.title === "Отправить примеры")
        ?.lastInteraction,
    ).toMatchObject({ type: "Письмо", contactName: "Иван Петров" });

    const conflict = await request(app.getHttpServer())
      .post(`/api/v1/tasks/${taskId}/complete`)
      .set("Idempotency-Key", "test-key-http-replay-0001")
      .send({ ...command, summary: "Payload изменён" })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
  });

  it("publishes one immutable weekly snapshot for the same cut-off and formula", async () => {
    const command = {
      periodStart: "2026-08-10",
      dataAsOf: "2026-08-17T10:00:00+03:00",
      formulaVersion: "weekly-v1",
    };
    const first = await request(app.getHttpServer())
      .post("/api/v1/reports/weekly/snapshots")
      .set("Idempotency-Key", "test-key-weekly-report-0001")
      .send(command)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post("/api/v1/reports/weekly/snapshots")
      .set("Idempotency-Key", "test-key-weekly-report-0001")
      .send(command)
      .expect(201);
    const sameCutOff = await request(app.getHttpServer())
      .post("/api/v1/reports/weekly/snapshots")
      .set("Idempotency-Key", "test-key-weekly-report-0002")
      .send(command)
      .expect(201);

    expect(replay.body).toEqual(first.body);
    expect(sameCutOff.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      periodStart: "2026-08-09T21:00:00.000Z",
      periodEnd: "2026-08-16T20:59:59.999Z",
      dataAsOf: "2026-08-17T07:00:00.000Z",
      revision: 1,
      formulaVersion: "weekly-v1",
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      payload: {
        network: {
          activePlacements: null,
          completeness: "unavailable",
        },
        dataQuality: {
          completeness: "partial",
        },
      },
    });
  });

  it("creates a new revision for a later data_as_of and returns it as latest", async () => {
    const later = await request(app.getHttpServer())
      .post("/api/v1/reports/weekly/snapshots")
      .set("Idempotency-Key", "test-key-weekly-report-late-0001")
      .send({
        periodStart: "2026-08-10",
        dataAsOf: "2026-08-18T10:00:00+03:00",
        formulaVersion: "weekly-v1",
      })
      .expect(201);
    const latest = await request(app.getHttpServer())
      .get("/api/v1/reports/weekly/snapshots/latest")
      .expect(200);

    expect(later.body).toMatchObject({
      revision: 2,
      dataAsOf: "2026-08-18T07:00:00.000Z",
    });
    expect(latest.body).toEqual(later.body);
  });

  it("rejects a weekly snapshot that does not start on Monday", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/reports/weekly/snapshots")
      .set("Idempotency-Key", "test-key-weekly-report-invalid-0001")
      .send({
        periodStart: "2026-08-11",
        dataAsOf: "2026-08-18T10:00:00+03:00",
        formulaVersion: "weekly-v1",
      })
      .expect(422);

    expect(response.body).toMatchObject({
      code: "ANL-009",
      fieldErrors: { periodStart: expect.any(String) },
    });
  });

  it("проводит кандидата Радара от URL до возможности и первой задачи", async () => {
    const command = {
      name: "Региональный медиацентр",
      url: "https://regional-media.example/news/video",
      source: "Ручной поиск",
      topic: "Новости",
      language: "ru",
      geography: "Россия",
      publicationFrequency: "daily",
      contactsFound: true,
      estimatedVideoPagesMin: 20,
      estimatedVideoPagesMax: 100,
    };
    const created = await request(app.getHttpServer())
      .post("/api/v1/radar/candidates")
      .set("Idempotency-Key", "test-key-radar-create-0001")
      .send(command)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post("/api/v1/radar/candidates")
      .set("Idempotency-Key", "test-key-radar-create-0001")
      .send(command)
      .expect(201);
    expect(replay.body).toEqual(created.body);

    const requested = await request(app.getHttpServer())
      .post(`/api/v1/radar/candidates/${created.body.id}/checks`)
      .set("Idempotency-Key", "test-key-radar-check-0001")
      .expect(202);
    expect(requested.body).toMatchObject({
      status: "new",
      inspectionPending: true,
      version: 2,
      evidence: [],
    });
    const requestReplay = await request(app.getHttpServer())
      .post(`/api/v1/radar/candidates/${created.body.id}/checks`)
      .set("Idempotency-Key", "test-key-radar-check-0001")
      .expect(202);
    expect(requestReplay.body).toEqual(requested.body);

    // The endpoint only queues the check; the inspection itself runs in the
    // background (in-process in dev mode, radar recheck worker in postgres).
    await app.get<RadarPort>(RADAR_PORT).processRequestedInspections();

    const queue = await request(app.getHttpServer()).get("/api/v1/radar/candidates").expect(200);
    const checked = {
      body: queue.body.candidates.find(
        (candidate: { id: string }) => candidate.id === created.body.id,
      ),
    };
    expect(checked.body).toMatchObject({
      status: "ready",
      inspectionPending: false,
      version: 3,
      evidence: [{ status: "found", playerType: "RUTUBE", method: "l0-html" }],
    });

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/radar/candidates/${created.body.id}/decisions`)
      .set("Idempotency-Key", "test-key-radar-accept-0001")
      .send({
        version: checked.body.version,
        decision: "accept",
        reason: "Целевой контент и RUTUBE подтверждены",
      })
      .expect(200);
    expect(accepted.body).toMatchObject({
      status: "accepted",
      source: "Ручной поиск",
      acceptedOrganizationId: expect.any(String),
      acceptedOpportunityId: expect.any(String),
      decisions: [{ decision: "accept", reason: "Целевой контент и RUTUBE подтверждены" }],
    });

    const today = await request(app.getHttpServer()).get("/api/v1/today").expect(200);
    expect(today.body.actions).toContainEqual(
      expect.objectContaining({
        organizationId: accepted.body.acceptedOrganizationId,
        opportunityId: accepted.body.acceptedOpportunityId,
        stageCode: "S2",
        title: expect.stringContaining("m.ivanova@new-media.example"),
        contacts: expect.arrayContaining([
          expect.objectContaining({
            fullName: "Мария Иванова",
            role: "Коммерческий директор",
            email: "m.ivanova@new-media.example",
            isPrimary: true,
          }),
        ]),
      }),
    );
  });

  it("отклонение кандидата требует reasonCode и фиксирует score на момент решения", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/radar/candidates")
      .set("Idempotency-Key", "test-key-radar-reject-create-01")
      .send({
        name: "Отклоняемый сайт",
        url: "https://reject-media.example/news",
        source: "Ручной поиск",
        topic: "Новости",
      })
      .expect(201);

    const invalid = await request(app.getHttpServer())
      .post(`/api/v1/radar/candidates/${created.body.id}/decisions`)
      .set("Idempotency-Key", "test-key-radar-reject-0001")
      .send({
        version: created.body.version,
        decision: "reject",
        reason: "Видеоконтента нет",
      })
      .expect(422);
    expect(invalid.body).toMatchObject({
      code: "RADAR_VALIDATION_FAILED",
      fieldErrors: { reasonCode: expect.any(String) },
    });

    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/radar/candidates/${created.body.id}/decisions`)
      .set("Idempotency-Key", "test-key-radar-reject-0002")
      .send({
        version: created.body.version,
        decision: "reject",
        reason: "Видеоконтента нет",
        reasonCode: "no_video_editorial",
      })
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: "rejected",
      rejectionReason: "Видеоконтента нет",
      decisions: [
        {
          decision: "reject",
          reasonCode: "no_video_editorial",
          scoreAtDecision: created.body.score.total,
          formulaVersion: "partner-score-v2",
        },
      ],
    });

    // The stored decision (radar_decision columns in postgres mode) is
    // visible again through the queue view.
    const queue = await request(app.getHttpServer()).get("/api/v1/radar/candidates").expect(200);
    const listed = queue.body.candidates.find(
      (candidate: { id: string }) => candidate.id === created.body.id,
    );
    expect(listed.decisions).toEqual([
      expect.objectContaining({
        decision: "reject",
        reasonCode: "no_video_editorial",
        scoreAtDecision: created.body.score.total,
        formulaVersion: "partner-score-v2",
      }),
    ]);
  });

  it("загружает очередь Радара из CSV с построчным протоколом", async () => {
    const imported = await request(app.getHttpServer())
      .post("/api/v1/radar/candidates/import")
      .set("Idempotency-Key", "test-key-radar-import-0001")
      .attach(
        "file",
        Buffer.from(
          [
            "organization_name,domain,source,segment",
            "Импорт Радара,radar-import.example,Каталог,Медиа",
            "Дубль строки,radar-import.example,Каталог,Медиа",
          ].join("\n"),
        ),
        "radar.csv",
      )
      .expect(201);

    expect(imported.body).toMatchObject({
      fileName: "radar.csv",
      format: "csv",
      total: 2,
      created: 1,
      skipped: 1,
      failed: 0,
    });
    expect(imported.body.rows).toEqual([
      expect.objectContaining({
        rowNo: 2,
        status: "created",
        hostNormalized: "radar-import.example",
      }),
      expect.objectContaining({ rowNo: 3, status: "skipped", candidateId: null }),
    ]);
  });
});
