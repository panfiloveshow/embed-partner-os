import { OpportunityStatus, PrismaClient, TaskStatus, UserStatus } from "@prisma/client";
import { calculatePriority, type PriorityFactors } from "@embed-os/domain";

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
    permissions: [
      "role:observer",
      "today.read",
      "partners.read",
      "contacts.view",
      "opportunities.read",
      "radar.read",
      "placements.read",
      "reports.view",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000005",
    subject: "bootstrap:sergey.volkov",
    displayName: "Сергей Волков",
    email: "sergey.volkov@example.invalid",
    permissions: [
      "role:partner_manager",
      "today.read",
      "tasks.write",
      "partners.read",
      "partners.write",
      "partners.export",
      "contacts.view",
      "contacts.write",
      "opportunities.read",
      "opportunities.stage.write",
      "radar.read",
      "radar.write",
      "placements.read",
      "reports.view",
      "imports.organizations.write",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000006",
    subject: "bootstrap:elena.orlova",
    displayName: "Елена Орлова",
    email: "elena.orlova@example.invalid",
    permissions: [
      "role:team_lead",
      "today.read",
      "tasks.write",
      "partners.read",
      "partners.write",
      "partners.export",
      "partners.export.audit",
      "contacts.view",
      "contacts.write",
      "opportunities.read",
      "opportunities.stage.write",
      "radar.read",
      "radar.write",
      "placements.read",
      "placements.write",
      "reports.view",
      "reports.generate",
      "imports.organizations.write",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000007",
    subject: "bootstrap:mikhail.lebedev",
    displayName: "Михаил Лебедев",
    email: "mikhail.lebedev@example.invalid",
    permissions: [
      "role:technical_specialist",
      "today.read",
      "partners.read",
      "contacts.view",
      "opportunities.read",
      "radar.read",
      "placements.read",
      "placements.write",
      "reports.view",
    ],
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

type ActionGroup = "critical" | "today" | "later" | "waiting";

interface SeedActionDefinition {
  /** 1-based task number matching the in-memory `task-N` fixture ids. */
  taskNumber: number;
  organization: string;
  domain: string;
  stageCode: string;
  stageLabel: string;
  title: string;
  dueAt: string;
  group: ActionGroup;
  factors: PriorityFactors;
  interactionType: string;
  interactionSummary: string;
}

const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1_000;
/** Moscow calendar date the fixture dataset below was authored for. */
const SEED_ANCHOR_DATE = "2026-08-17";

const seedContactNames = [
  "Ольга Смирнова",
  "Алексей Кузнецов",
  "Мария Попова",
  "Дмитрий Волков",
  "Артём Соколов",
  "Екатерина Лебедева",
  "Павел Морозов",
  "Анна Орлова",
  "Сергей Гришин",
  "Наталья Белова",
  "Максим Фролов",
  "Ирина Власова",
  "Роман Титов",
  "Юлия Крылова",
];

/**
 * The same demo dataset as the in-memory TodayService fixture: 16 open
 * actions across 16 organizations. Both persistence modes must serve
 * identical data so the HTTP contract suite passes against either.
 */
const actions: SeedActionDefinition[] = [
  {
    taskNumber: 1,
    organization: "Медиа Новости",
    domain: "medianovosti.ru",
    stageCode: "S7",
    stageLabel: "Интеграция",
    title: "Ответить на запрос по API",
    dueAt: "2026-08-15T14:00:00+03:00",
    group: "critical",
    factors: {
      overdueBusinessDays: 4,
      partnerScore: 85,
      hasInboundResponse: true,
      isIntegrationOrPilot: true,
    },
    interactionType: "Письмо от партнёра",
    interactionSummary: "Запросили обновлённую спецификацию API и примеры интеграции",
  },
  {
    taskNumber: 2,
    organization: "Спорт Онлайн",
    domain: "sport-online.ru",
    stageCode: "S7",
    stageLabel: "Интеграция",
    title: "Предоставить тестовый доступ",
    dueAt: "2026-08-16T12:00:00+03:00",
    group: "critical",
    factors: {
      overdueBusinessDays: 2,
      partnerScore: 90,
      hasCriticalTechnicalAlert: true,
      isIntegrationOrPilot: true,
    },
    interactionType: "Системное событие",
    interactionSummary: "Две последовательные ошибки проверки тестовой страницы",
  },
  {
    taskNumber: 3,
    organization: "Городской портал",
    domain: "citymedia.ru",
    stageCode: "S4",
    stageLabel: "Диалог",
    title: "Согласовать условия размещения",
    dueAt: "2026-08-16T18:00:00+03:00",
    group: "critical",
    factors: {
      overdueBusinessDays: 1,
      partnerScore: 78,
      hasInboundResponse: true,
      inactiveDays: 9,
    },
    interactionType: "Входящее письмо",
    interactionSummary: "Партнёр готов обсудить финальный формат размещения",
  },
  {
    taskNumber: 4,
    organization: "Кинообзор",
    domain: "kino-review.ru",
    stageCode: "S7",
    stageLabel: "Интеграция",
    title: "Проверить готовность плеера",
    dueAt: "2026-08-17T11:00:00+03:00",
    group: "today",
    factors: {
      partnerScore: 72,
      isIntegrationOrPilot: true,
      hasCriticalTechnicalAlert: true,
    },
    interactionType: "Техническая заметка",
    interactionSummary: "Тестовая страница опубликована и ждёт проверки",
  },
  {
    taskNumber: 5,
    organization: "TechBlog",
    domain: "techblog.ru",
    stageCode: "S7",
    stageLabel: "Интеграция",
    title: "Согласовать параметры плеера",
    dueAt: "2026-08-17T13:30:00+03:00",
    group: "today",
    factors: {
      partnerScore: 68,
      isIntegrationOrPilot: true,
      hasInboundResponse: true,
    },
    interactionType: "Письмо",
    interactionSummary: "Получен список разрешённых параметров iframe",
  },
  {
    taskNumber: 6,
    organization: "LifeStyle Media",
    domain: "lifestyle.media",
    stageCode: "S5",
    stageLabel: "Предложение",
    title: "Отправить коммерческое предложение",
    dueAt: "2026-08-17T15:00:00+03:00",
    group: "today",
    factors: {
      partnerScore: 81,
      hasInboundResponse: true,
    },
    interactionType: "Звонок",
    interactionSummary: "Подтверждён интерес к пилоту на новостном разделе",
  },
  {
    taskNumber: 7,
    organization: "АвтоПортал",
    domain: "autoportal.ru",
    stageCode: "S6",
    stageLabel: "Согласование",
    title: "Запросить доступ к сайту",
    dueAt: "2026-08-17T16:00:00+03:00",
    group: "today",
    factors: {
      partnerScore: 66,
      inactiveDays: 12,
    },
    interactionType: "Встреча",
    interactionSummary: "Техническая команда готовит тестовый контур",
  },
  {
    taskNumber: 8,
    organization: "Новости Регионов",
    domain: "regions.news",
    stageCode: "S3",
    stageLabel: "Первичный контакт",
    title: "Подготовить follow-up",
    dueAt: "2026-08-17T16:30:00+03:00",
    group: "today",
    factors: {
      partnerScore: 59,
      inactiveDays: 18,
    },
    interactionType: "Письмо",
    interactionSummary: "Первое письмо отправлено четыре дня назад",
  },
  {
    taskNumber: 9,
    organization: "EduVideo",
    domain: "eduvideo.ru",
    stageCode: "S2",
    stageLabel: "Квалифицирован",
    title: "Найти технического контакта",
    dueAt: "2026-08-17T17:00:00+03:00",
    group: "today",
    factors: {
      partnerScore: 74,
      inactiveDays: 6,
    },
    interactionType: "Исследование",
    interactionSummary: "Найдены редакционный и коммерческий контакты",
  },
  {
    taskNumber: 10,
    organization: "Деловой обзор",
    domain: "business-review.ru",
    stageCode: "S4",
    stageLabel: "Диалог",
    title: "Подтвердить встречу",
    dueAt: "2026-08-17T18:00:00+03:00",
    group: "today",
    factors: {
      partnerScore: 70,
      hasInboundResponse: true,
    },
    interactionType: "Календарь",
    interactionSummary: "Партнёр предложил два слота для встречи",
  },
  {
    taskNumber: 11,
    organization: "Travel Guide",
    domain: "travelguide.ru",
    stageCode: "S4",
    stageLabel: "Диалог",
    title: "Договориться о встрече",
    dueAt: "2026-08-19T12:00:00+03:00",
    group: "later",
    factors: {
      partnerScore: 64,
      inactiveDays: 9,
    },
    interactionType: "Звонок",
    interactionSummary: "Контакт попросил вернуться после планёрки",
  },
  {
    taskNumber: 12,
    organization: "Музыка Онлайн",
    domain: "music-online.ru",
    stageCode: "S5",
    stageLabel: "Предложение",
    title: "Уточнить формат размещения",
    dueAt: "2026-08-20T15:00:00+03:00",
    group: "later",
    factors: {
      partnerScore: 57,
      inactiveDays: 6,
    },
    interactionType: "Заметка",
    interactionSummary: "Нужно выбрать формат для мобильной версии",
  },
  {
    taskNumber: 13,
    organization: "Game World",
    domain: "gameworld.ru",
    stageCode: "S7",
    stageLabel: "Интеграция",
    title: "Ожидание доступа в тестовый контур",
    dueAt: "2026-08-21T10:00:00+03:00",
    group: "waiting",
    factors: {
      partnerScore: 80,
      isIntegrationOrPilot: true,
      isWaitingBeforeReview: true,
    },
    interactionType: "Ожидание",
    interactionSummary: "Доступ готовит служба безопасности партнёра",
  },
  {
    taskNumber: 14,
    organization: "Новости Мира",
    domain: "world-news.ru",
    stageCode: "S4",
    stageLabel: "Диалог",
    title: "Ожидание ответа на КП",
    dueAt: "2026-08-22T10:00:00+03:00",
    group: "waiting",
    factors: {
      partnerScore: 73,
      isWaitingBeforeReview: true,
    },
    interactionType: "Ожидание",
    interactionSummary: "Коммерческое предложение на внутреннем согласовании",
  },
  {
    taskNumber: 15,
    organization: "Домашний уют",
    domain: "home-style.ru",
    stageCode: "S5",
    stageLabel: "Предложение",
    title: "Ожидание материалов",
    dueAt: "2026-08-23T10:00:00+03:00",
    group: "waiting",
    factors: {
      partnerScore: 61,
      isWaitingBeforeReview: true,
    },
    interactionType: "Ожидание",
    interactionSummary: "Редакция готовит перечень страниц с видео",
  },
  {
    taskNumber: 16,
    organization: "Финансы Онлайн",
    domain: "finance-online.ru",
    stageCode: "S6",
    stageLabel: "Согласование",
    title: "Ожидание согласования безопасности",
    dueAt: "2026-08-24T10:00:00+03:00",
    group: "waiting",
    factors: {
      partnerScore: 76,
      isWaitingBeforeReview: true,
    },
    interactionType: "Ожидание",
    interactionSummary: "Документы переданы службе информационной безопасности",
  },
];

/** The in-memory fixture starts the day with 6 tasks already completed. */
const COMPLETED_TODAY = 6;

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

  const now = new Date();
  const shiftMs = seedDayShiftMs(now);

  for (const action of actions) {
    const index = action.taskNumber - 1;
    const organizationId = uuid(1_000 + index);
    const domainId = uuid(2_000 + index);
    const opportunityId = uuid(3_000 + index);
    const taskId = uuid(4_000 + index);
    const isSharedContact = action.taskNumber <= 2;
    const contactId = uuid(isSharedContact ? 5_000 : 5_000 + index);
    const contactLinkId = uuid(6_000 + index);
    const interactionId = uuid(8_000 + index);
    const inMediaGroup = action.taskNumber === 1 || action.taskNumber === 3;
    const legalName =
      action.taskNumber === 1
        ? "ООО «Медиа Новости»"
        : action.taskNumber === 3
          ? "АО «Городской портал»"
          : null;
    const contactName = isSharedContact
      ? "Иван Петров"
      : (seedContactNames[(action.taskNumber - 3) % seedContactNames.length] ?? "Иван Петров");
    const contactRole =
      action.taskNumber === 1
        ? "Технический директор"
        : action.taskNumber === 2
          ? "Консультант по интеграции"
          : action.stageCode === "S7"
            ? "Технический руководитель"
            : "Руководитель направления";
    const contactDepartment = action.stageCode === "S7" ? "ИТ" : "Развитие бизнеса";
    const priority = calculatePriority(action.factors);
    const dueAt = new Date(new Date(action.dueAt).getTime() + shiftMs);
    const opportunityStatus =
      action.group === "waiting" ? OpportunityStatus.WAITING : OpportunityStatus.ACTIVE;
    const waitingFields =
      action.group === "waiting"
        ? {
            waitingReason: action.interactionSummary,
            waitingFor: action.title.replace(/^Ожидание\s*/u, "") || action.title,
            reviewAt: dueAt,
          }
        : { waitingReason: null, waitingFor: null, reviewAt: null };
    const partnerScore =
      typeof action.factors.partnerScore === "number" ? action.factors.partnerScore : 0;
    // The in-memory fixture omits the interaction outcome for S2 opportunities
    // so the BR-003 readiness check reports the missing field.
    const interactionOutcome = action.stageCode === "S2" ? "" : "Следующий шаг согласован";

    await prisma.$transaction(async (transaction) => {
      await transaction.organization.upsert({
        where: { id: organizationId },
        update: {
          groupId: inMediaGroup ? MEDIA_GROUP_ID : null,
          name: action.organization,
          legalName,
          ownerId: BOOTSTRAP_USER_ID,
          segment: "Медиа и контент",
        },
        create: {
          id: organizationId,
          groupId: inMediaGroup ? MEDIA_GROUP_ID : null,
          name: action.organization,
          legalName,
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
          verifiedAt: new Date("2026-08-15T11:32:00+03:00"),
        },
      });
      await transaction.contact.upsert({
        where: { id: contactId },
        update: {
          fullName: contactName,
          verifiedAt: new Date("2026-08-15T11:32:00+03:00"),
        },
        create: {
          id: contactId,
          fullName: contactName,
          email: isSharedContact
            ? "ivan.petrov@partners.example.invalid"
            : `ivan.petrov@${action.domain}`,
          messenger: isSharedContact ? "@ivan_petrov" : `@ivan_${action.taskNumber}`,
          source: "seed",
          verifiedAt: new Date("2026-08-15T11:32:00+03:00"),
          restrictions: {},
        },
      });
      await transaction.contactOrganization.upsert({
        where: { id: contactLinkId },
        update: {
          role: contactRole,
          department: contactDepartment,
          isPrimary: true,
          validTo: null,
        },
        create: {
          id: contactLinkId,
          contactId,
          organizationId,
          role: contactRole,
          department: contactDepartment,
          isPrimary: true,
        },
      });
      await transaction.opportunity.upsert({
        where: { id: opportunityId },
        update: {
          ownerId: BOOTSTRAP_USER_ID,
          stageCode: action.stageCode,
          stageLabel: action.stageLabel,
          status: opportunityStatus,
          score: partnerScore,
          stageData: opportunityStageData(action.domain),
          ...waitingFields,
        },
        create: {
          id: opportunityId,
          organizationId,
          processVersion: 1,
          ownerId: BOOTSTRAP_USER_ID,
          type: "initial-embed",
          stageCode: action.stageCode,
          stageLabel: action.stageLabel,
          status: opportunityStatus,
          score: partnerScore,
          stageData: opportunityStageData(action.domain),
          ...waitingFields,
        },
      });
      await transaction.task.upsert({
        where: { id: taskId },
        update: {
          title: action.title,
          dueAt,
          priorityScore: priority.score,
          priorityReasons: priority.reasons,
        },
        create: {
          id: taskId,
          opportunityId,
          ownerId: BOOTSTRAP_USER_ID,
          type: "follow-up",
          title: action.title,
          dueAt,
          priorityScore: priority.score,
          priorityReasons: priority.reasons,
          status: TaskStatus.OPEN,
          source: "seed",
        },
      });
      await transaction.opportunity.update({
        where: { id: opportunityId },
        data: { nextTaskId: taskId },
      });
      // Interactions are append-only (immutability trigger), so only insert.
      await transaction.interaction.createMany({
        data: [
          {
            id: interactionId,
            opportunityId,
            taskId,
            // Deliberately unattributed: the in-memory fixture models the
            // last interaction without a contact link, and the merge contract
            // pins movedInteractions=0 for seeded contacts.
            contactId: null,
            authorId: BOOTSTRAP_USER_ID,
            type: action.interactionType,
            occurredAt: new Date("2026-08-15T14:32:00+03:00"),
            summary: action.interactionSummary,
            outcome: interactionOutcome,
            source: "seed",
          },
        ],
        skipDuplicates: true,
      });
    });
  }

  // Six follow-ups closed earlier "today", mirroring the in-memory fixture's
  // completed counter. Attached to the later/waiting opportunities that no
  // partner-card contract assertion inspects.
  for (let index = 0; index < COMPLETED_TODAY; index += 1) {
    const opportunityId = uuid(3_000 + 10 + index);
    const completedTaskId = uuid(7_001 + index);
    await prisma.task.upsert({
      where: { id: completedTaskId },
      update: { completedAt: now },
      create: {
        id: completedTaskId,
        opportunityId,
        ownerId: BOOTSTRAP_USER_ID,
        type: "follow-up",
        title: `Утренний созвон с партнёром №${index + 1}`,
        dueAt: now,
        priorityScore: 10,
        priorityReasons: [],
        status: TaskStatus.COMPLETED,
        outcome: "Выполнено",
        completedAt: now,
        source: "seed",
      },
    });
  }

  console.log(`Seed completed: ${actions.length} active opportunities`);
}

function uuid(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function startOfMoscowDay(now: Date): Date {
  const moscow = new Date(now.getTime() + MOSCOW_UTC_OFFSET_MS);
  const startLocalAsUtc = Date.UTC(
    moscow.getUTCFullYear(),
    moscow.getUTCMonth(),
    moscow.getUTCDate(),
  );
  return new Date(startLocalAsUtc - MOSCOW_UTC_OFFSET_MS);
}

/**
 * Fixture dates are authored relative to SEED_ANCHOR_DATE and shifted to the
 * current Moscow day at seed time, so the today/later grouping stays stable
 * regardless of when the seed runs — the same rule the in-memory fixture uses.
 */
function seedDayShiftMs(now: Date): number {
  const anchorStart = new Date(`${SEED_ANCHOR_DATE}T00:00:00+03:00`).getTime();
  return startOfMoscowDay(now).getTime() - anchorStart;
}

function opportunityStageData(domain: string) {
  return {
    geography: "Россия",
    videoPlayerType: "iframe",
    dataSource: "Ручное исследование",
    researchCheckedAt: "2026-08-15T11:32:00.000Z",
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
