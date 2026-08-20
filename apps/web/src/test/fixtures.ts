import type { ContactOption, TodayAction } from "@embed-os/contracts";

export function makeContact(overrides: Partial<ContactOption> = {}): ContactOption {
  return {
    id: "contact-1",
    fullName: "Анна Смирнова",
    role: "Редактор",
    department: null,
    email: "anna@partner.ru",
    phone: null,
    messenger: null,
    isPrimary: true,
    ...overrides,
  };
}

export function makeTodayAction(overrides: Partial<TodayAction> = {}): TodayAction {
  return {
    id: "task-1",
    organizationId: "org-1",
    organizationName: "Партнёр Медиа",
    domain: "partner.ru",
    opportunityId: "opp-1",
    opportunityVersion: 3,
    processVersion: 1,
    opportunityStatus: "ACTIVE",
    stageCode: "S5",
    stageLabel: "Предложение",
    title: "Отправить условия размещения",
    dueAt: "2026-08-20T09:00:00.000Z",
    group: "today",
    priorityScore: 42,
    priorityReasons: [],
    ownerName: "Иван Петров",
    contacts: [makeContact()],
    lastInteraction: null,
    ...overrides,
  };
}
