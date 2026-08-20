import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeTask,
  createContact,
  fetchContactRegistry,
  fetchPartnerCard,
  fetchPartnerRegistry,
  exportPartnerRegistry,
  fetchFunnel,
  fetchLatestWeeklyReport,
  generateWeeklyReport,
  fetchPlacementChecks,
  fetchPlacements,
  linkContact,
  mergeContact,
  updateContactRecord,
  archiveContactRecord,
  restoreContactRecord,
  rescheduleTask,
  registerPlacement,
  runPlacementL0Check,
  updatePlacement,
  archivePlacement,
  cancelOrganizationImport,
  commitOrganizationImport,
  previewOrganizationImport,
  transitionOpportunityStage,
  adjustRadarCandidateScore,
  createRadarCandidate,
  decideRadarCandidate,
  fetchRadar,
  fetchSession,
  inspectRadarCandidate,
  importRadarCandidates,
  fetchSlaSettings,
  updateSlaSettings,
  configureApiAccessToken,
  configureApiAccessTokenProvider,
  fetchAccessAdministration,
  createAccessUser,
  updateAccessUser,
} from "./api.js";

describe("session", () => {
  afterEach(() => {
    configureApiAccessTokenProvider(null);
    configureApiAccessToken(null);
    vi.unstubAllGlobals();
  });

  it("attaches an in-memory Bearer token without persisting it in browser storage", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      subject: "corp:user-1",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    configureApiAccessToken("signed.jwt.value");

    await fetchSession();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/session", {
      signal: undefined,
      headers: { authorization: "Bearer signed.jwt.value" },
    });
  });

  it("loads the server-verified role and permissions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      subject: "bootstrap:anna.sokolova",
      userId: "user-1",
      displayName: "Анна Соколова",
      initials: "АС",
      email: null,
      role: "admin",
      permissions: ["system.admin"],
      scope: { mode: "all", teamId: null, teamName: "Команда внедрения" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const session = await fetchSession();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/session", { signal: undefined });
    expect(session).toMatchObject({ role: "admin", displayName: "Анна Соколова" });
  });

  it("refreshes an external token once after 401 and retries the request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
        detail: "Token expired",
      }), { status: 401, headers: { "content-type": "application/problem+json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        subject: "corp:user-1",
        role: "observer",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const getAccessToken = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) =>
      forceRefresh ? "renewed.jwt.value" : "expired.jwt.value");
    vi.stubGlobal("fetch", fetchMock);
    configureApiAccessTokenProvider({ getAccessToken });

    await fetchSession();

    expect(getAccessToken).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/session", {
      signal: undefined,
      headers: { authorization: "Bearer expired.jwt.value" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/session", {
      signal: undefined,
      headers: { authorization: "Bearer renewed.jwt.value" },
    });
  });

  it("deduplicates token acquisition for parallel startup requests", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      subject: "corp:user-1",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const getAccessToken = vi.fn(async () => "shared.jwt.value");
    vi.stubGlobal("fetch", fetchMock);
    configureApiAccessTokenProvider({ getAccessToken });

    await Promise.all([fetchSession(), fetchSession()]);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("SLA settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and publishes a versioned configuration", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      processDefinitionId: "process-2",
      version: 2,
      stages: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const command = {
      version: 1,
      escalationAfterDays: 3,
      thresholds: {
        S0: 2, S1: 2, S2: 3, S3: 3, S4: 5, S5: 5,
        S6: 5, S7: 7, S8: 7, S9: 14, S10: 14,
      },
      reason: "Настройка пилотной команды",
    } as const;

    await fetchSlaSettings();
    await updateSlaSettings(command, "sla-settings-key-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/settings/sla", { signal: undefined });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/settings/sla", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "idempotency-key": "sla-settings-key-1" }),
      body: JSON.stringify(command),
    }));
  });
});

describe("access administration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the role matrix and updates a user with optimistic locking", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      users: [],
      teams: [],
      roles: ["admin", "observer"],
      permissions: ["today.read", "system.admin"],
      roleDefaults: { admin: ["system.admin"], observer: ["today.read"] },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const command: Parameters<typeof updateAccessUser>[1] = {
      version: 2,
      status: "active",
      role: "observer",
      permissions: ["today.read"],
      reason: "Ограничение доступа после смены функции",
    };

    await fetchAccessAdministration();
    await createAccessUser({
      subject: "oidc:new-user",
      displayName: "Новый Пользователь",
      email: "new.user@example.test",
      teamId: null,
      role: "observer",
      permissions: ["today.read"],
      reason: "Регистрация для пилота",
    }, "access-user-create-key-1");
    await updateAccessUser("user/1", command, "access-user-update-key-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/settings/access/users",
      { signal: undefined },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/settings/access/users",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "idempotency-key": "access-user-create-key-1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/settings/access/users/user%2F1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "idempotency-key": "access-user-update-key-1" }),
        body: JSON.stringify(command),
      }),
    );
  });
});

describe("contact registry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads filtered contacts and sends versioned lifecycle mutations", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "contact-1",
      version: 2,
      contacts: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchContactRegistry({
      search: "Иван Петров",
      status: "archived",
      organizationId: "org/1",
      duplicatesOnly: true,
    });
    await updateContactRecord("contact/1", {
      version: 2,
      fullName: "Иван Петров",
      email: "ivan@example.ru",
      source: "Встреча",
    }, "contact-update-key");
    await archiveContactRecord("contact/1", {
      version: 3,
      reason: "Контакт устарел",
    }, "contact-archive-key");
    await restoreContactRecord("contact/1", {
      version: 4,
      reason: "Контакт подтверждён",
    }, "contact-restore-key");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/contacts?search=%D0%98%D0%B2%D0%B0%D0%BD+%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2&status=archived&organizationId=org%2F1&duplicatesOnly=true",
      { signal: undefined },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/contacts/contact%2F1", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "idempotency-key": "contact-update-key" }),
      body: expect.stringContaining('"version":2'),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/contacts/contact%2F1/archive", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ version: 3, reason: "Контакт устарел" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/contacts/contact%2F1/restore", expect.objectContaining({
      headers: expect.objectContaining({ "idempotency-key": "contact-restore-key" }),
    }));
  });
});

describe("partner registry", () => {
  afterEach(() => {
    configureApiAccessToken(null);
    vi.unstubAllGlobals();
  });

  it("loads the organization filters and unified partner card", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      partners: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPartnerRegistry({
      search: "Медиа",
      groupId: "group/1",
      segment: "Новости",
      ownerId: "user/1",
      stageCode: "S7",
      scoreMin: 60,
      scoreMax: 90,
      integrationStatus: "planned",
      activeAfter: "2026-08-01T00:00:00.000Z",
    });
    await fetchPartnerCard("org/1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/partners?search=%D0%9C%D0%B5%D0%B4%D0%B8%D0%B0&groupId=group%2F1&segment=%D0%9D%D0%BE%D0%B2%D0%BE%D1%81%D1%82%D0%B8&ownerId=user%2F1&stageCode=S7&scoreMin=60&scoreMax=90&integrationStatus=planned&activeAfter=2026-08-01T00%3A00%3A00.000Z",
      { signal: undefined },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/partners/org%2F1",
      { signal: undefined },
    );
  });

  it("exports the current filter set with the trusted actor and returns audit metadata", async () => {
    const fetchMock = vi.fn(async () => new Response("\ufeffpartner csv", {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=\"rutube-partners-2026-08-19.csv\"",
        "x-export-audit-id": "audit/export-1",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await exportPartnerRegistry({
      search: "Медиа",
      scoreMin: 70,
      integrationStatus: "active",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/partners/exports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ search: "Медиа", scoreMin: 70, integrationStatus: "active" }),
    });
    expect(result.fileName).toBe("rutube-partners-2026-08-19.csv");
    expect(result.auditId).toBe("audit/export-1");
    expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()).slice(0, 3))).toEqual([239, 187, 191]);
  });
});

describe("radar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("использует версии и caller-owned idempotency keys во всех мутациях", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "radar/1",
      version: 2,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchRadar();
    await createRadarCandidate({ name: "Медиа", url: "media.example", source: "Радар" }, "radar-create-key");
    await inspectRadarCandidate("radar/1", "radar-check-key");
    await decideRadarCandidate("radar/1", {
      version: 2,
      decision: "reject",
      reason: "Не соответствует профилю",
    }, "radar-decision-key");
    await adjustRadarCandidateScore("radar/1", {
      version: 2,
      adjustment: -5,
      comment: "Подтверждённый риск",
    }, "radar-score-key");
    await importRadarCandidates(new File(["organization_name,domain,source"], "radar.csv"), "radar-import-key");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/radar/candidates", { signal: undefined });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/radar/candidates", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "radar-create-key" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/radar/candidates/radar%2F1/checks", expect.objectContaining({
      headers: { "idempotency-key": "radar-check-key" },
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/radar/candidates/radar%2F1/decisions", expect.objectContaining({
      body: expect.stringContaining('"version":2'),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/v1/radar/candidates/radar%2F1/score-adjustments", expect.objectContaining({
      headers: expect.objectContaining({ "idempotency-key": "radar-score-key" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/v1/radar/candidates/import", expect.objectContaining({
      method: "POST",
      headers: { "idempotency-key": "radar-import-key" },
      body: expect.any(FormData),
    }));
  });
});

describe("organization import", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads the selected file as multipart data", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "import-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["organization_name,domain,source"], "partners.csv", {
      type: "text/csv",
    });

    await previewOrganizationImport(file);

    const [path, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0] ?? [];
    expect(path).toBe("/api/v1/imports/organizations/preview");
    expect(init).toEqual(expect.objectContaining({ method: "POST" }));
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
  });

  it("commits resolutions and cancels previews with caller-owned idempotency keys", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "import-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await commitOrganizationImport(
      "import/1",
      { resolutions: [{ rowNo: 3, decision: "skip" }] },
      "import-commit-key",
    );
    await cancelOrganizationImport("import/1", "import-cancel-key");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/imports/organizations/import%2F1/commit",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "import-commit-key",
        },
        body: JSON.stringify({ resolutions: [{ rowNo: 3, decision: "skip" }] }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/imports/organizations/import%2F1/cancel",
      expect.objectContaining({
        method: "POST",
        headers: { "idempotency-key": "import-cancel-key" },
      }),
    );
  });
});

describe("completeTask", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the caller-owned idempotency key with the mutation", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          generatedAt: "2026-08-17T13:00:00.000Z",
          teamName: "Команда внедрения",
          currentUser: { id: "user-1", name: "Анна", initials: "А" },
          summary: {
            critical: 0,
            today: 0,
            waiting: 0,
            completed: 1,
            rescheduled: 0,
            stageChanges: 0,
            launches: 0,
          },
          actions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await completeTask(
      "task-1",
      {
        contactId: "contact-1",
        interactionType: "email",
        outcome: "Получен ответ",
        summary: "Партнёр подтвердил следующий шаг",
        next: {
          mode: "task",
          title: "Отправить примеры",
          dueAt: "2026-08-18T09:00:00.000Z",
        },
      },
      "test-key-web-retry-0001",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tasks/task-1/complete",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "test-key-web-retry-0001",
        },
        body: expect.stringContaining('"contactId":"contact-1"'),
      }),
    );
  });
});

describe("rescheduleTask", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the new deadline, mandatory reason and idempotency key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ actions: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await rescheduleTask("task/1", {
      dueAt: "2026-08-25T09:00:00.000Z",
      reason: "Партнёр перенёс встречу",
    }, "task-reschedule-web-0001");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tasks/task%2F1/reschedule",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "task-reschedule-web-0001",
        },
        body: JSON.stringify({
          dueAt: "2026-08-25T09:00:00.000Z",
          reason: "Партнёр перенёс встречу",
        }),
      }),
    );
  });
});

describe("funnel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the shared opportunity collection", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ total: 0, opportunities: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchFunnel();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/opportunities", { signal: undefined });
  });
});

describe("createContact", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the contact to the organization with an idempotency key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "contact-2",
          fullName: "Мария Орлова",
          role: "Редактор",
          department: null,
          email: "maria@example.ru",
          phone: null,
          messenger: null,
          isPrimary: false,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createContact(
      "org-1",
      { fullName: "Мария Орлова", role: "Редактор", email: "maria@example.ru" },
      "test-key-contact-web-0001",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/organizations/org-1/contacts",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "test-key-contact-web-0001",
        },
        body: expect.stringContaining('"fullName":"Мария Орлова"'),
      }),
    );
  });
});

describe("linkContact", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts an organization-specific role for an existing contact", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "contact-2",
          fullName: "Мария Орлова",
          role: "Технический эксперт",
          department: "ИТ",
          email: "maria@example.ru",
          phone: null,
          messenger: null,
          isPrimary: false,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await linkContact(
      "org-2",
      "contact-2",
      { role: "Технический эксперт", department: "ИТ" },
      "test-key-contact-link-web-0001",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/organizations/org-2/contacts/contact-2/link",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "test-key-contact-link-web-0001",
        },
        body: expect.stringContaining('"role":"Технический эксперт"'),
      }),
    );
  });
});

describe("mergeContact", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the canonical contact and explicit reason with an idempotency key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          sourceContactId: "contact-source",
          targetContactId: "contact-target",
          movedOrganizationLinks: 1,
          closedConflictingLinks: 0,
          movedInteractions: 2,
          outboxEventId: "event-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await mergeContact(
      "contact-source",
      { targetContactId: "contact-target", reason: "Подтверждённый дубль" },
      "test-key-contact-merge-web-0001",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/contacts/contact-source/merge",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "test-key-contact-merge-web-0001",
        },
        body: JSON.stringify({
          targetContactId: "contact-target",
          reason: "Подтверждённый дубль",
        }),
      }),
    );
  });
});

describe("weekly reports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the latest immutable snapshot", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "report-1", revision: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchLatestWeeklyReport();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/reports/weekly/snapshots/latest",
      { signal: undefined },
    );
  });

  it("publishes a snapshot with an idempotency key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "report-1", revision: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const command = {
      periodStart: "2026-08-10",
      dataAsOf: "2026-08-18T07:00:00.000Z",
      formulaVersion: "weekly-v1",
    };

    await generateWeeklyReport(command, "test-key-weekly-web-0001");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/reports/weekly/snapshots",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "test-key-weekly-web-0001",
        },
        body: JSON.stringify(command),
      },
    );
  });
});

describe("placements", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the registry and a placement history", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchPlacements();
    await fetchPlacementChecks("placement/1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/placements", { signal: undefined });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/placements/placement%2F1/checks",
      { signal: undefined },
    );
  });

  it("runs a manual L0 check with the caller-owned idempotency key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ alertChange: "none" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runPlacementL0Check("placement-1", "placement-check-web-0001");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/placements/placement-1/l0-checks",
      {
        method: "POST",
        headers: { "idempotency-key": "placement-check-web-0001" },
      },
    );
  });

  it("registers a placement with an idempotency key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "placement-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const command = {
      organizationId: "org-1",
      opportunityId: "opp-1",
      pageUrl: "https://partner.example/video",
      embedType: "video" as const,
      environment: "production" as const,
      businessStatus: "active" as const,
      launchedAt: "2026-08-18T08:00:00.000Z",
    };

    await registerPlacement(command, "placement-register-web-0001");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/placements",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "placement-register-web-0001",
        },
        body: JSON.stringify(command),
      },
    );
  });

  it("updates and archives a placement with versioned commands", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "placement-1", version: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const update = { version: 1, businessStatus: "paused" as const, reason: "Пауза партнёра" };
    const archive = { version: 2, reason: "Размещение демонтировано" };

    await updatePlacement("placement/1", update, "placement-update-web-0001");
    await archivePlacement("placement/1", archive, "placement-archive-web-0001");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/placements/placement%2F1", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "placement-update-web-0001",
      },
      body: JSON.stringify(update),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/placements/placement%2F1/archive", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "placement-archive-web-0001",
      },
      body: JSON.stringify(archive),
    });
  });
});

describe("opportunity stages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a versioned stage transition with an idempotency key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ opportunityId: "opp-1", version: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const command = {
      version: 1,
      toStageCode: "S8" as const,
      reason: "Пилот готов",
      stageData: {
        pilotStartsAt: "2026-08-20T07:00:00.000Z",
        pilotEndsAt: "2026-09-03T07:00:00.000Z",
        successCriteria: "99% успешных проверок",
        pilotReviewAt: "2026-08-27T07:00:00.000Z",
        metricsSource: "RUTUBE Analytics",
      },
    };

    await transitionOpportunityStage("opp/1", command, "stage-transition-web-0001");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/opportunities/opp%2F1/stage-transitions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "stage-transition-web-0001",
        },
        body: JSON.stringify(command),
      },
    );
  });
});
