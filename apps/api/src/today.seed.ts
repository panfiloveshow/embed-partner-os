import type { ActionGroup, TodayAction } from "@embed-os/contracts";
import { calculatePriority } from "@embed-os/domain";

export interface SeedAction extends Omit<TodayAction, "priorityScore" | "priorityReasons"> {
  factors: Parameters<typeof calculatePriority>[0];
}

export const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Moscow calendar date the seed dataset below was authored for. */
const SEED_ANCHOR_DATE = "2026-08-17";

export function startOfMoscowDay(now: Date): Date {
  const moscow = new Date(now.getTime() + MOSCOW_UTC_OFFSET_MS);
  const startLocalAsUtc = Date.UTC(
    moscow.getUTCFullYear(),
    moscow.getUTCMonth(),
    moscow.getUTCDate(),
  );
  return new Date(startLocalAsUtc - MOSCOW_UTC_OFFSET_MS);
}

export function endOfMoscowDay(now: Date): Date {
  return new Date(startOfMoscowDay(now).getTime() + DAY_MS - 1);
}

/**
 * Seed dates are authored relative to SEED_ANCHOR_DATE and shifted to the
 * current Moscow day at load time, so grouping stays consistent with the
 * dynamic "end of today" boundary regardless of when the process starts.
 */
function seedDayShiftMs(now: Date): number {
  const anchorStart = new Date(`${SEED_ANCHOR_DATE}T00:00:00+03:00`).getTime();
  return startOfMoscowDay(now).getTime() - anchorStart;
}

function shiftSeedDate(value: string, shiftMs: number): string {
  const shifted = new Date(new Date(value).getTime() + shiftMs);
  const moscow = new Date(shifted.getTime() + MOSCOW_UTC_OFFSET_MS);
  return `${moscow.toISOString().slice(0, 19)}+03:00`;
}

export function buildSeedActions(): TodayAction[] {
  const shiftMs = seedDayShiftMs(new Date());
  return seedActions.map(({ factors, ...action }) => {
    const priority = calculatePriority(factors);
    return {
      ...action,
      dueAt: action.dueAt === null ? null : shiftSeedDate(action.dueAt, shiftMs),
      priorityScore: priority.score,
      priorityReasons: priority.reasons,
    };
  });
}

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

const seedActions: SeedAction[] = [
  seed(
    "task-1",
    "Медиа Новости",
    "medianovosti.ru",
    "S7",
    "Интеграция",
    "Ответить на запрос по API",
    "2026-08-15T14:00:00+03:00",
    "critical",
    {
      overdueBusinessDays: 4,
      partnerScore: 85,
      hasInboundResponse: true,
      isIntegrationOrPilot: true,
    },
    "Письмо от партнёра",
    "Запросили обновлённую спецификацию API и примеры интеграции",
  ),
  seed(
    "task-2",
    "Спорт Онлайн",
    "sport-online.ru",
    "S7",
    "Интеграция",
    "Предоставить тестовый доступ",
    "2026-08-16T12:00:00+03:00",
    "critical",
    {
      overdueBusinessDays: 2,
      partnerScore: 90,
      hasCriticalTechnicalAlert: true,
      isIntegrationOrPilot: true,
    },
    "Системное событие",
    "Две последовательные ошибки проверки тестовой страницы",
  ),
  seed(
    "task-3",
    "Городской портал",
    "citymedia.ru",
    "S4",
    "Диалог",
    "Согласовать условия размещения",
    "2026-08-16T18:00:00+03:00",
    "critical",
    {
      overdueBusinessDays: 1,
      partnerScore: 78,
      hasInboundResponse: true,
      inactiveDays: 9,
    },
    "Входящее письмо",
    "Партнёр готов обсудить финальный формат размещения",
  ),
  seed(
    "task-4",
    "Кинообзор",
    "kino-review.ru",
    "S7",
    "Интеграция",
    "Проверить готовность плеера",
    "2026-08-17T11:00:00+03:00",
    "today",
    {
      partnerScore: 72,
      isIntegrationOrPilot: true,
      hasCriticalTechnicalAlert: true,
    },
    "Техническая заметка",
    "Тестовая страница опубликована и ждёт проверки",
  ),
  seed(
    "task-5",
    "TechBlog",
    "techblog.ru",
    "S7",
    "Интеграция",
    "Согласовать параметры плеера",
    "2026-08-17T13:30:00+03:00",
    "today",
    {
      partnerScore: 68,
      isIntegrationOrPilot: true,
      hasInboundResponse: true,
    },
    "Письмо",
    "Получен список разрешённых параметров iframe",
  ),
  seed(
    "task-6",
    "LifeStyle Media",
    "lifestyle.media",
    "S5",
    "Предложение",
    "Отправить коммерческое предложение",
    "2026-08-17T15:00:00+03:00",
    "today",
    {
      partnerScore: 81,
      hasInboundResponse: true,
    },
    "Звонок",
    "Подтверждён интерес к пилоту на новостном разделе",
  ),
  seed(
    "task-7",
    "АвтоПортал",
    "autoportal.ru",
    "S6",
    "Согласование",
    "Запросить доступ к сайту",
    "2026-08-17T16:00:00+03:00",
    "today",
    {
      partnerScore: 66,
      inactiveDays: 12,
    },
    "Встреча",
    "Техническая команда готовит тестовый контур",
  ),
  seed(
    "task-8",
    "Новости Регионов",
    "regions.news",
    "S3",
    "Первичный контакт",
    "Подготовить follow-up",
    "2026-08-17T16:30:00+03:00",
    "today",
    {
      partnerScore: 59,
      inactiveDays: 18,
    },
    "Письмо",
    "Первое письмо отправлено четыре дня назад",
  ),
  seed(
    "task-9",
    "EduVideo",
    "eduvideo.ru",
    "S2",
    "Квалифицирован",
    "Найти технического контакта",
    "2026-08-17T17:00:00+03:00",
    "today",
    {
      partnerScore: 74,
      inactiveDays: 6,
    },
    "Исследование",
    "Найдены редакционный и коммерческий контакты",
  ),
  seed(
    "task-10",
    "Деловой обзор",
    "business-review.ru",
    "S4",
    "Диалог",
    "Подтвердить встречу",
    "2026-08-17T18:00:00+03:00",
    "today",
    {
      partnerScore: 70,
      hasInboundResponse: true,
    },
    "Календарь",
    "Партнёр предложил два слота для встречи",
  ),
  seed(
    "task-11",
    "Travel Guide",
    "travelguide.ru",
    "S4",
    "Диалог",
    "Договориться о встрече",
    "2026-08-19T12:00:00+03:00",
    "later",
    {
      partnerScore: 64,
      inactiveDays: 9,
    },
    "Звонок",
    "Контакт попросил вернуться после планёрки",
  ),
  seed(
    "task-12",
    "Музыка Онлайн",
    "music-online.ru",
    "S5",
    "Предложение",
    "Уточнить формат размещения",
    "2026-08-20T15:00:00+03:00",
    "later",
    {
      partnerScore: 57,
      inactiveDays: 6,
    },
    "Заметка",
    "Нужно выбрать формат для мобильной версии",
  ),
  seed(
    "task-13",
    "Game World",
    "gameworld.ru",
    "S7",
    "Интеграция",
    "Ожидание доступа в тестовый контур",
    "2026-08-21T10:00:00+03:00",
    "waiting",
    {
      partnerScore: 80,
      isIntegrationOrPilot: true,
      isWaitingBeforeReview: true,
    },
    "Ожидание",
    "Доступ готовит служба безопасности партнёра",
  ),
  seed(
    "task-14",
    "Новости Мира",
    "world-news.ru",
    "S4",
    "Диалог",
    "Ожидание ответа на КП",
    "2026-08-22T10:00:00+03:00",
    "waiting",
    {
      partnerScore: 73,
      isWaitingBeforeReview: true,
    },
    "Ожидание",
    "Коммерческое предложение на внутреннем согласовании",
  ),
  seed(
    "task-15",
    "Домашний уют",
    "home-style.ru",
    "S5",
    "Предложение",
    "Ожидание материалов",
    "2026-08-23T10:00:00+03:00",
    "waiting",
    {
      partnerScore: 61,
      isWaitingBeforeReview: true,
    },
    "Ожидание",
    "Редакция готовит перечень страниц с видео",
  ),
  seed(
    "task-16",
    "Финансы Онлайн",
    "finance-online.ru",
    "S6",
    "Согласование",
    "Ожидание согласования безопасности",
    "2026-08-24T10:00:00+03:00",
    "waiting",
    {
      partnerScore: 76,
      isWaitingBeforeReview: true,
    },
    "Ожидание",
    "Документы переданы службе информационной безопасности",
  ),
];

function seed(
  id: string,
  organizationName: string,
  domain: string,
  stageCode: string,
  stageLabel: string,
  title: string,
  dueAt: string,
  group: ActionGroup,
  factors: SeedAction["factors"],
  interactionType: string,
  interactionSummary: string,
): SeedAction {
  const organizationId = `org-${id}`;
  const isSharedContact = id === "task-1" || id === "task-2";
  const taskNumber = Number(id.replace("task-", ""));
  const contactName = isSharedContact
    ? "Иван Петров"
    : (seedContactNames[(taskNumber - 3) % seedContactNames.length] ?? "Иван Петров");
  return {
    id,
    organizationId,
    organizationName,
    domain,
    opportunityId: `opp-${id}`,
    opportunityVersion: 1,
    processVersion: 1,
    opportunityStatus: group === "waiting" ? "WAITING" : "ACTIVE",
    partnerScore: typeof factors.partnerScore === "number" ? factors.partnerScore : 0,
    organizationSegment: "Медиа и контент",
    opportunityStageData: defaultStageData(domain),
    stageCode,
    stageLabel,
    title,
    dueAt,
    group,
    factors,
    ownerName: "Анна Соколова",
    contacts: [
      {
        id: isSharedContact ? "contact-shared-ivan" : `contact-${id}`,
        fullName: contactName,
        role:
          id === "task-1"
            ? "Технический директор"
            : id === "task-2"
              ? "Консультант по интеграции"
              : stageCode === "S7"
                ? "Технический руководитель"
                : "Руководитель направления",
        department: stageCode === "S7" ? "ИТ" : "Развитие бизнеса",
        email: isSharedContact ? "ivan.petrov@partners.example.invalid" : `ivan.petrov@${domain}`,
        phone: null,
        messenger: isSharedContact ? "@ivan_petrov" : `@ivan_${id.replace("task-", "")}`,
        isPrimary: true,
      },
    ],
    lastInteraction: {
      type: interactionType,
      occurredAt: "2026-08-15T14:32:00+03:00",
      contactName,
      summary: interactionSummary,
      ...(stageCode === "S2" ? {} : { outcome: "Следующий шаг согласован" }),
    },
  };
}

function defaultStageData(domain: string) {
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
    embedType: "video" as const,
    integrationChecklist: ["iframe добавлен", "страница доступна", "CSP проверен"],
    launchDueAt: "2026-08-28T10:00:00.000Z",
    pilotStartsAt: "2026-08-20T10:00:00.000Z",
    pilotEndsAt: "2026-09-03T10:00:00.000Z",
    successCriteria: "Плеер доступен минимум в 99% L0-проверок",
    pilotReviewAt: "2026-08-27T10:00:00.000Z",
    metricsSource: "RUTUBE Analytics",
  };
}
