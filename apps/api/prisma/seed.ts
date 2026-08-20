import { PrismaClient, TaskStatus, UserStatus } from "@prisma/client";

const prisma = new PrismaClient();
const BOOTSTRAP_USER_ID = "00000000-0000-4000-8000-000000000001";
const TEAM_ID = "00000000-0000-4000-8000-000000000002";
const PROCESS_ID = "00000000-0000-4000-8000-000000000100";
const MEDIA_GROUP_ID = "00000000-0000-4000-8000-000000000200";
const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000004";
const pilotUsers = [
  {
    id: "00000000-0000-4000-8000-000000000003",
    subject: "bootstrap:observer",
    displayName: "Наблюдатель",
    email: "observer@example.invalid",
    permissions: ["role:observer", "today.read", "partners.read", "contacts.view", "opportunities.read", "radar.read", "placements.read", "reports.view"],
  },
  {
    id: "00000000-0000-4000-8000-000000000005",
    subject: "bootstrap:sergey.volkov",
    displayName: "Сергей Волков",
    email: "sergey.volkov@example.invalid",
    permissions: ["role:partner_manager", "today.read", "tasks.write", "partners.read", "partners.write", "partners.export", "contacts.view", "contacts.write", "opportunities.read", "opportunities.stage.write", "radar.read", "radar.write", "placements.read", "reports.view", "imports.organizations.write"],
  },
  {
    id: "00000000-0000-4000-8000-000000000006",
    subject: "bootstrap:elena.orlova",
    displayName: "Елена Орлова",
    email: "elena.orlova@example.invalid",
    permissions: ["role:team_lead", "today.read", "tasks.write", "partners.read", "partners.write", "partners.export", "partners.export.audit", "contacts.view", "contacts.write", "opportunities.read", "opportunities.stage.write", "radar.read", "radar.write", "placements.read", "placements.write", "reports.view", "reports.generate", "imports.organizations.write"],
  },
  {
    id: "00000000-0000-4000-8000-000000000007",
    subject: "bootstrap:mikhail.lebedev",
    displayName: "Михаил Лебедев",
    email: "mikhail.lebedev@example.invalid",
    permissions: ["role:technical_specialist", "today.read", "partners.read", "contacts.view", "opportunities.read", "radar.read", "placements.read", "placements.write", "reports.view"],
  },
] as const;
const PROCESS_SCHEMA = {
  stages: ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "SX", "SL"],
  sla: {
    escalationAfterDays: 3,
    thresholds: {
      S0: 2,
      S1: 2,
      S2: 3,
      S3: 3,
      S4: 5,
      S5: 5,
      S6: 5,
      S7: 7,
      S8: 7,
      S9: 14,
      S10: 14,
    },
  },
};

const actions = [
  {
    organization: "Медиа Новости",
    domain: "medianovosti.ru",
    stageCode: "S7",
    stageLabel: "Интеграция",
    title: "Ответить на запрос по API",
    dueAt: "2026-08-15T14:00:00+03:00",
    score: 85,
    priorityScore: 92,
    priorityReasons: [
      { code: "overdue", label: "Просрочка 4 дня" },
      { code: "inbound", label: "Ответ партнёра" },
      { code: "partner-potential", label: "Высокий потенциал" },
    ],
  },
  {
    organization: "Спорт Онлайн",
    domain: "sport-online.ru",
    stageCode: "S7",
    stageLabel: "Интеграция",
    title: "Предоставить тестовый доступ",
    dueAt: "2026-08-16T12:00:00+03:00",
    score: 90,
    priorityScore: 78,
    priorityReasons: [
      { code: "technical-risk", label: "Технический риск" },
      { code: "overdue", label: "Просрочка 2 дня" },
    ],
  },
  {
    organization: "Городской портал",
    domain: "citymedia.ru",
    stageCode: "S4",
    stageLabel: "Диалог",
    title: "Согласовать условия размещения",
    dueAt: "2026-08-17T16:00:00+03:00",
    score: 78,
    priorityScore: 64,
    priorityReasons: [
      { code: "inbound", label: "Ответ партнёра" },
      { code: "partner-potential", label: "Высокий потенциал" },
    ],
  },
  {
    organization: "Кинообзор",
    domain: "kino-review.ru",
    stageCode: "S7",
    stageLabel: "Интеграция",
    title: "Проверить готовность плеера",
    dueAt: "2026-08-17T18:00:00+03:00",
    score: 72,
    priorityScore: 49,
    priorityReasons: [
      { code: "technical-risk", label: "Технический риск" },
      { code: "partner-potential", label: "Высокий потенциал" },
    ],
  },
  {
    organization: "Travel Guide",
    domain: "travelguide.ru",
    stageCode: "S4",
    stageLabel: "Диалог",
    title: "Договориться о встрече",
    dueAt: "2026-08-19T12:00:00+03:00",
    score: 64,
    priorityScore: 16,
    priorityReasons: [{ code: "partner-potential", label: "Высокий потенциал" }],
  },
];

async function main() {
  await prisma.team.upsert({
    where: { id: TEAM_ID },
    update: { name: "Команда внедрения" },
    create: { id: TEAM_ID, name: "Команда внедрения" },
  });

  await prisma.user.upsert({
    where: { id: BOOTSTRAP_USER_ID },
    update: {
      teamId: TEAM_ID,
      displayName: "Анна Соколова",
      status: UserStatus.ACTIVE,
    },
    create: {
      id: BOOTSTRAP_USER_ID,
      externalSubject: "bootstrap:anna.sokolova",
      teamId: TEAM_ID,
      displayName: "Анна Соколова",
      email: "anna.sokolova@example.invalid",
      status: UserStatus.ACTIVE,
      timezone: "Europe/Moscow",
    },
  });

  await prisma.user.upsert({
    where: { id: SYSTEM_USER_ID },
    update: {
      teamId: TEAM_ID,
      displayName: "Embed OS Automation",
      status: UserStatus.ACTIVE,
    },
    create: {
      id: SYSTEM_USER_ID,
      externalSubject: "system:automation",
      teamId: TEAM_ID,
      displayName: "Embed OS Automation",
      email: "automation@example.invalid",
      status: UserStatus.ACTIVE,
      timezone: "Europe/Moscow",
    },
  });

  for (const permission of ["role:admin", "partners.export"] as const) {
    await prisma.userPermission.upsert({
      where: {
        userId_permission: {
          userId: BOOTSTRAP_USER_ID,
          permission,
        },
      },
      update: { revokedAt: null, source: "seed" },
      create: {
        userId: BOOTSTRAP_USER_ID,
        permission,
        source: "seed",
      },
    });
  }

  for (const user of pilotUsers) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: {
        externalSubject: user.subject,
        teamId: TEAM_ID,
        displayName: user.displayName,
        email: user.email,
        status: UserStatus.ACTIVE,
      },
      create: {
        id: user.id,
        externalSubject: user.subject,
        teamId: TEAM_ID,
        displayName: user.displayName,
        email: user.email,
        status: UserStatus.ACTIVE,
        timezone: "Europe/Moscow",
      },
    });
    for (const permission of user.permissions) {
      await prisma.userPermission.upsert({
        where: { userId_permission: { userId: user.id, permission } },
        update: { revokedAt: null, source: "seed" },
        create: { userId: user.id, permission, source: "seed" },
      });
    }
  }

  await prisma.organizationGroup.upsert({
    where: { id: MEDIA_GROUP_ID },
    update: { name: "Медиа Альянс", status: "ACTIVE", archivedAt: null },
    create: {
      id: MEDIA_GROUP_ID,
      teamId: TEAM_ID,
      name: "Медиа Альянс",
    },
  });

  await prisma.processDefinition.upsert({
    where: { version: 1 },
    update: { schemaJson: PROCESS_SCHEMA },
    create: {
      id: PROCESS_ID,
      version: 1,
      status: "PUBLISHED",
      publishedAt: new Date("2026-08-17T09:00:00+03:00"),
      schemaJson: PROCESS_SCHEMA,
    },
  });

  for (const [index, action] of actions.entries()) {
    const organizationId = uuid(1_000 + index);
    const domainId = uuid(2_000 + index);
    const opportunityId = uuid(3_000 + index);
    const taskId = uuid(4_000 + index);
    const contactId = uuid(index < 2 ? 5_000 : 5_000 + index);
    const contactLinkId = uuid(6_000 + index);

    await prisma.$transaction(async (transaction) => {
      await transaction.organization.upsert({
        where: { id: organizationId },
        update: {
          groupId: index === 0 || index === 2 ? MEDIA_GROUP_ID : null,
          name: action.organization,
          legalName: index === 0
            ? "ООО «Медиа Новости»"
            : index === 2 ? "АО «Городской портал»" : null,
          ownerId: BOOTSTRAP_USER_ID,
          segment: "Медиа и контент",
        },
        create: {
          id: organizationId,
          groupId: index === 0 || index === 2 ? MEDIA_GROUP_ID : null,
          name: action.organization,
          legalName: index === 0
            ? "ООО «Медиа Новости»"
            : index === 2 ? "АО «Городской портал»" : null,
          ownerId: BOOTSTRAP_USER_ID,
          segment: "Медиа и контент",
        },
      });
      await transaction.domain.upsert({
        where: { id: domainId },
        update: { hostNormalized: action.domain, isPrimary: true },
        create: {
          id: domainId,
          organizationId,
          hostNormalized: action.domain,
          isPrimary: true,
          source: "seed",
          verifiedAt: new Date("2026-08-17T09:00:00+03:00"),
        },
      });
      await transaction.contact.upsert({
        where: { id: contactId },
        update: {
          fullName: index < 2 ? "Иван Петров" : `Контакт ${action.organization}`,
          verifiedAt: new Date("2026-08-17T09:00:00+03:00"),
        },
        create: {
          id: contactId,
          fullName: index < 2 ? "Иван Петров" : `Контакт ${action.organization}`,
          email: index < 2 ? "ivan.petrov@partners.example.invalid" : null,
          messenger: index < 2 ? "@ivan_petrov" : null,
          source: "seed",
          verifiedAt: new Date("2026-08-17T09:00:00+03:00"),
          restrictions: {},
        },
      });
      await transaction.contactOrganization.upsert({
        where: { id: contactLinkId },
        update: {
          role: index === 0 ? "Технический директор" : "Контакт по интеграции",
          isPrimary: true,
          validTo: null,
        },
        create: {
          id: contactLinkId,
          contactId,
          organizationId,
          role: index === 0 ? "Технический директор" : "Контакт по интеграции",
          department: index === 0 ? "ИТ" : "Развитие бизнеса",
          isPrimary: true,
        },
      });
      await transaction.opportunity.upsert({
        where: { id: opportunityId },
        update: {
          ownerId: BOOTSTRAP_USER_ID,
          stageCode: action.stageCode,
          stageLabel: action.stageLabel,
          score: action.score,
          stageData: opportunityStageData(action.domain),
        },
        create: {
          id: opportunityId,
          organizationId,
          processVersion: 1,
          ownerId: BOOTSTRAP_USER_ID,
          type: "initial-embed",
          stageCode: action.stageCode,
          stageLabel: action.stageLabel,
          score: action.score,
          stageData: opportunityStageData(action.domain),
        },
      });
      await transaction.task.upsert({
        where: { id: taskId },
        update: {
          title: action.title,
          dueAt: new Date(action.dueAt),
          priorityScore: action.priorityScore,
          priorityReasons: action.priorityReasons,
        },
        create: {
          id: taskId,
          opportunityId,
          ownerId: BOOTSTRAP_USER_ID,
          type: "follow-up",
          title: action.title,
          dueAt: new Date(action.dueAt),
          priorityScore: action.priorityScore,
          priorityReasons: action.priorityReasons,
          status: TaskStatus.OPEN,
          source: "seed",
        },
      });
      await transaction.opportunity.update({
        where: { id: opportunityId },
        data: { nextTaskId: taskId },
      });
    });
  }

  console.log(`Seed completed: ${actions.length} active opportunities`);
}

function uuid(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function opportunityStageData(domain: string) {
  return {
    geography: "Россия",
    videoPlayerType: "iframe",
    dataSource: "seed",
    researchCheckedAt: "2026-08-17T06:00:00.000Z",
    priorityReason: "Подтверждён потенциал видеосценария",
    rutubeUseCase: "Встраивание редакционного видео",
    need: "Стабильный видеоплеер для редакционных материалов",
    stakeholders: ["Редакция", "Техническая команда"],
    objections: "Критичных возражений нет",
    agreedDueAt: "2026-08-25T10:00:00.000Z",
    testUrl: `https://${domain}/rutube-test`,
    technicalContact: "Иван Петров",
    embedType: "video",
    integrationChecklist: ["iframe добавлен", "страница доступна", "CSP проверен"],
    launchDueAt: "2026-08-28T10:00:00.000Z",
    pilotStartsAt: "2026-08-20T10:00:00.000Z",
    pilotEndsAt: "2026-09-03T10:00:00.000Z",
    successCriteria: "Плеер доступен минимум в 99% L0-проверок",
    pilotReviewAt: "2026-08-27T10:00:00.000Z",
    metricsSource: "RUTUBE Analytics",
  };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
