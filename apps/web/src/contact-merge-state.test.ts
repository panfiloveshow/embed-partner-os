import { describe, expect, it } from "vitest";
import type { ContactOption, TodayAction, TodayPayload } from "@embed-os/contracts";
import { applyContactMerge, collectMergeTargets } from "./App.js";

const source: ContactOption = {
  id: "contact-source",
  fullName: "Мария Орлова",
  role: "Редактор",
  department: "Контент",
  email: "source@example.ru",
  phone: null,
  messenger: null,
  isPrimary: true,
};
const target: ContactOption = {
  id: "contact-target",
  fullName: "Мария Орлова",
  role: "Технический директор",
  department: "ИТ",
  email: "target@example.ru",
  phone: null,
  messenger: "@maria",
  isPrimary: false,
};

describe("contact merge state", () => {
  it("replaces the source identity and preserves its organization-specific context", () => {
    const payload = today([
      action("task-source", "org-source", "Редакция", [source]),
      action("task-target", "org-target", "Платформа", [target]),
    ]);

    const result = applyContactMerge(payload, source.id, target.id);

    expect(result.actions[0]?.contacts).toEqual([
      {
        ...target,
        role: source.role,
        department: source.department,
        isPrimary: source.isPrimary,
      },
    ]);
    expect(result.actions[1]?.contacts).toEqual([target]);
  });

  it("removes the source when the canonical contact is already linked", () => {
    const payload = today([
      action("task-conflict", "org-conflict", "Медиа", [source, target]),
    ]);

    const result = applyContactMerge(payload, source.id, target.id);

    expect(result.actions[0]?.contacts).toEqual([target]);
  });

  it("deduplicates canonical choices and lists every linked organization", () => {
    const payload = today([
      action("task-source", "org-source", "Редакция", [source]),
      action("task-target-1", "org-target-1", "Платформа", [target]),
      action("task-target-2", "org-target-2", "Видеосервис", [target]),
    ]);

    expect(collectMergeTargets(payload, source.id)).toEqual([
      { contact: target, organizationNames: ["Платформа", "Видеосервис"] },
    ]);
  });
});

function today(actions: TodayAction[]): TodayPayload {
  return {
    generatedAt: "2026-08-17T09:00:00.000Z",
    teamName: "Команда внедрения",
    currentUser: { id: "user-1", name: "Анна", initials: "А" },
    summary: {
      critical: 0,
      today: 0,
      waiting: 0,
      completed: 0,
      rescheduled: 0,
      stageChanges: 0,
      launches: 0,
    },
    actions,
  };
}

function action(
  id: string,
  organizationId: string,
  organizationName: string,
  contacts: ContactOption[],
): TodayAction {
  return {
    id,
    organizationId,
    organizationName,
    domain: `${organizationId}.example.ru`,
    opportunityId: `opportunity-${id}`,
    opportunityVersion: 1,
    processVersion: 1,
    opportunityStatus: "ACTIVE",
    stageCode: "S4",
    stageLabel: "Диалог",
    title: "Связаться с партнёром",
    dueAt: "2026-08-17T12:00:00.000Z",
    group: "today",
    priorityScore: 50,
    priorityReasons: [],
    ownerName: "Анна",
    contacts,
    lastInteraction: null,
  };
}
