import { randomUUID } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  ActionGroup,
  CompleteTaskCommand,
  ContactOption,
  ContactRegistryItem,
  ContactRegistryPayload,
  MergeContactResult,
  RadarResearch,
  TodayAction,
  TodayPayload,
  OpportunityStageTransitionResult,
  TransitionOpportunityStageCommand,
} from "@embed-os/contracts";
import {
  calculatePriority,
  parseCompleteTaskCommand,
  parseRescheduleTaskCommand,
  assertLaterDeadline,
} from "@embed-os/domain";
import { ContactNotAvailableError } from "./application/task-completion.service.js";
import {
  completionRequestHash,
  IdempotencyConflictError,
  parseIdempotencyKey,
  taskRescheduleRequestHash,
} from "./application/idempotency.js";
import { ContactRegistryService, type InMemoryContactProfile } from "./contact-registry.service.js";
import type { TodayPort } from "./today.port.js";
import type { ContactPort } from "./contact.port.js";
import { buildSeedActions, endOfMoscowDay } from "./today.seed.js";

@Injectable()
export class TodayService implements TodayPort, ContactPort {
  private actions: TodayAction[] = buildSeedActions();
  private completedToday = 6;
  private rescheduledToday = 1;
  private stageChangesToday = 2;
  private launchesToday = 1;
  private readonly idempotency = new Map<string, { requestHash: string; response: TodayPayload }>();
  private readonly taskRescheduleIdempotency = new Map<
    string,
    { requestHash: string; response: TodayPayload }
  >();
  private readonly contactRegistry = new ContactRegistryService(() => this.actions);

  getToday(): TodayPayload {
    return {
      generatedAt: new Date().toISOString(),
      teamName: "Команда внедрения",
      currentUser: { id: "user-anna", name: "Анна Соколова", initials: "АС" },
      summary: {
        critical: this.actions.filter((action) => action.group === "critical").length,
        today: this.actions.filter((action) => action.group === "today").length,
        waiting: this.actions.filter((action) => action.group === "waiting").length,
        completed: this.completedToday,
        rescheduled: this.rescheduledToday,
        stageChanges: this.stageChangesToday,
        launches: this.launchesToday,
      },
      actions: this.actions
        .map((action) => ({
          ...action,
          contacts: action.contacts.filter((contact) =>
            this.contactRegistry.isContactAvailable(contact.id),
          ),
        }))
        .sort(sortActions),
    };
  }

  /**
   * Moves every non-closed opportunity of the current process version onto a
   * newly published ProcessDefinition (SLA settings publication contract).
   * Returns the number of migrated opportunities.
   */
  migrateProcessVersion(fromVersion: number, toVersion: number): number {
    const migrated = new Set<string>();
    this.actions = this.actions.map((action) => {
      if (action.processVersion !== fromVersion || action.opportunityStatus === "CLOSED") {
        return action;
      }
      migrated.add(action.opportunityId);
      return { ...action, processVersion: toVersion };
    });
    return migrated.size;
  }

  getPlacementContext(organizationId: string, opportunityId: string) {
    const action = this.actions.find(
      (candidate) =>
        candidate.organizationId === organizationId && candidate.opportunityId === opportunityId,
    );
    if (!action) return null;
    const currentUser = this.getToday().currentUser;
    return {
      organizationName: action.organizationName,
      ownerId: currentUser.id,
      ownerName: action.ownerName,
    };
  }

  getOpportunityStageContext(opportunityId: string) {
    const action = this.actions.find((candidate) => candidate.opportunityId === opportunityId);
    if (!action) return null;
    return {
      opportunityId,
      version: action.opportunityVersion,
      processVersion: action.processVersion,
      stageCode: action.stageCode,
      status: action.opportunityStatus,
      primaryDomain: action.domain === "—" ? null : action.domain,
      topic: action.organizationSegment ?? null,
      score: action.partnerScore ?? null,
      ownerId: action.ownerName ? this.getToday().currentUser.id : null,
      hasNextAction: Boolean(action.id && action.dueAt),
      hasContactOrChannel: action.contacts.length > 0 || action.lastInteraction !== null,
      latestInteraction: action.lastInteraction
        ? {
            occurredAt: action.lastInteraction.occurredAt,
            type: action.lastInteraction.type,
            outcome: action.lastInteraction.outcome ?? null,
          }
        : null,
      stageData: structuredClone(action.opportunityStageData ?? {}),
    };
  }

  applyOpportunityStageTransition(
    result: OpportunityStageTransitionResult,
    command: TransitionOpportunityStageCommand,
  ) {
    if (result.toStageCode === "SL") {
      this.actions = this.actions.filter((action) => action.opportunityId !== result.opportunityId);
    } else {
      this.actions = this.actions.map((action) => {
        if (action.opportunityId !== result.opportunityId) return action;
        return {
          ...action,
          opportunityVersion: result.version,
          opportunityStatus: result.status,
          opportunityStageData: structuredClone(result.stageData),
          stageCode: result.toStageCode,
          stageLabel: result.stageLabel,
          ...(result.toStageCode === "SX"
            ? {
                group: "waiting" as const,
                dueAt: command.reviewAt ?? action.dueAt,
                title: `Вернуться к паузе: ${command.pauseReason ?? command.reason}`,
              }
            : {}),
        };
      });
    }
    this.stageChangesToday += 1;
    if (result.toStageCode === "S9") this.launchesToday += 1;
  }

  createTechnicalPlacementTask(input: {
    taskId: string;
    organizationId: string;
    opportunityId: string;
    organizationName: string;
    dueAt: string;
  }): string {
    if (this.actions.some(({ id }) => id === input.taskId)) return input.taskId;
    const template = this.actions.find(
      (action) =>
        action.organizationId === input.organizationId &&
        action.opportunityId === input.opportunityId,
    );
    if (!template) throw new NotFoundException("Возможность размещения не найдена");
    const priority = calculatePriority({
      partnerScore: Math.max(70, template.priorityScore),
      isIntegrationOrPilot: true,
      hasCriticalTechnicalAlert: true,
    });
    this.actions.push({
      ...template,
      id: input.taskId,
      title: `Исправить RUTUBE embed: ${input.organizationName}`,
      dueAt: input.dueAt,
      group: "critical",
      priorityScore: priority.score,
      priorityReasons: priority.reasons,
      contacts: structuredClone(template.contacts),
      lastInteraction: {
        type: "Системное событие",
        occurredAt: new Date().toISOString(),
        contactName: "Embed Monitor",
        summary: "Две последовательные L0-проверки завершились подтверждённой ошибкой",
      },
    });
    return input.taskId;
  }

  resolveTechnicalPlacementTask(taskId: string) {
    this.actions = this.actions.filter(({ id }) => id !== taskId);
  }

  createRadarCandidateAction(input: {
    taskId: string;
    organizationId: string;
    opportunityId: string;
    organizationName: string;
    domain: string;
    source: string;
    topic: string | null;
    geography: string | null;
    score: number;
    playerType: string;
    priorityReason: string;
    research: RadarResearch | null;
    dueAt: string;
  }): string {
    if (this.actions.some(({ id }) => id === input.taskId)) return input.taskId;
    const priority = calculatePriority({ partnerScore: input.score });
    const brief = input.research?.brief ?? null;
    const contacts = input.research
      ? this.createRadarContacts(input.organizationName, input.research)
      : [];
    this.actions.push({
      id: input.taskId,
      organizationId: input.organizationId,
      organizationName: input.organizationName,
      domain: input.domain,
      opportunityId: input.opportunityId,
      opportunityVersion: 1,
      processVersion: 1,
      opportunityStatus: "ACTIVE",
      partnerScore: input.score,
      organizationSegment: input.topic,
      opportunityStageData: {
        dataSource: input.source,
        researchCheckedAt: input.research?.collectedAt ?? new Date().toISOString(),
        geography: input.geography ?? "Не определена",
        videoPlayerType: input.playerType,
        priorityReason: input.priorityReason,
        ...(brief ? { rutubeUseCase: brief.rutubeUseCase } : {}),
      },
      stageCode: brief ? "S2" : "S0",
      stageLabel: brief ? "Квалифицирован" : "Найден",
      title: brief?.nextAction ?? `Исследовать кандидата из Радара: ${input.organizationName}`,
      dueAt: input.dueAt,
      group: groupForDate(input.dueAt),
      priorityScore: priority.score,
      priorityReasons: priority.reasons,
      ownerName: "Анна Соколова",
      contacts,
      lastInteraction: {
        type: "Системное событие",
        occurredAt: new Date().toISOString(),
        contactName: "Радар",
        summary: `Кандидат принят из источника «${input.source}»`,
      },
    });
    return input.taskId;
  }

  private createRadarContacts(organizationName: string, research: RadarResearch): ContactOption[] {
    const named = research.decisionMakers.slice(0, 4).map((lead) => ({
      fullName: lead.fullName ?? lead.role,
      role: lead.role,
      department: lead.department,
      email: lead.email,
      phone: lead.phone,
      messenger: lead.profileUrl,
      sourceUrl: lead.sourceUrl,
      restrictions: `Публичный рабочий контакт; ${lead.evidence}; confidence ${lead.confidence}`,
    }));
    const claimedChannels = new Set(
      named.flatMap(({ email, phone }) => [email, phone]).filter(Boolean),
    );
    const general = research.contacts
      .filter(
        ({ type, value }) => (type === "email" || type === "phone") && !claimedChannels.has(value),
      )
      .slice(0, Math.max(0, 4 - named.length))
      .map((lead) => {
        const role = research.brief.likelyContactRoles[0] ?? "Представитель площадки";
        return {
          fullName:
            lead.type === "email"
              ? `Публичный email — ${organizationName}`
              : `Публичный телефон — ${organizationName}`,
          role,
          department: role,
          email: lead.type === "email" ? lead.value : null,
          phone: lead.type === "phone" ? lead.value : null,
          messenger: null,
          sourceUrl: lead.sourceUrl,
          restrictions: "Публичный рабочий контакт; проверить адресата перед отправкой",
        };
      });
    return [...named, ...general].map((lead, index) => {
      const id = `contact-${randomUUID()}`;
      const profile: InMemoryContactProfile = {
        id,
        version: 1,
        fullName: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        messenger: lead.messenger,
        source: `radar:${lead.sourceUrl}`,
        verifiedAt: research.collectedAt,
        restrictions: lead.restrictions,
        archivedAt: null,
        updatedAt: research.collectedAt,
      };
      this.contactRegistry.registerProfile(profile);
      return {
        id,
        fullName: lead.fullName,
        role: lead.role,
        department: lead.department,
        email: profile.email,
        phone: profile.phone,
        messenger: profile.messenger,
        isPrimary: index === 0,
      };
    });
  }

  completeTask(taskId: string, input: unknown, rawIdempotencyKey: string): TodayPayload {
    const command = parseCompleteTaskCommand(input);
    const idempotencyKey = parseIdempotencyKey(rawIdempotencyKey);
    const requestHash = completionRequestHash(command);
    const idempotencyScope = `${taskId}:${idempotencyKey}`;
    const existing = this.idempotency.get(idempotencyScope);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return structuredClone(existing.response);
    }

    const actionIndex = this.actions.findIndex((action) => action.id === taskId);
    if (actionIndex < 0) {
      throw new NotFoundException(`Задача ${taskId} не найдена`);
    }

    const currentAction = this.actions[actionIndex];
    if (!currentAction) {
      throw new NotFoundException(`Задача ${taskId} не найдена`);
    }
    const contact = currentAction.contacts.find(({ id }) => id === command.contactId);
    if (!contact || !this.contactRegistry.isContactAvailable(command.contactId))
      throw new ContactNotAvailableError(command.contactId);

    this.actions.splice(actionIndex, 1);
    this.completedToday += 1;
    this.createNextAction(currentAction, command, contact.fullName);

    const response = this.getToday();
    this.idempotency.set(idempotencyScope, {
      requestHash,
      response: structuredClone(response),
    });
    return response;
  }

  rescheduleTask(taskId: string, input: unknown, rawIdempotencyKey: string): TodayPayload {
    const command = parseRescheduleTaskCommand(input);
    const idempotencyKey = parseIdempotencyKey(rawIdempotencyKey);
    const requestHash = taskRescheduleRequestHash(command);
    const scope = `${taskId}:${idempotencyKey}`;
    const replay = this.taskRescheduleIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }

    const actionIndex = this.actions.findIndex(({ id }) => id === taskId);
    const current = this.actions[actionIndex];
    if (actionIndex < 0 || !current) throw new NotFoundException(`Задача ${taskId} не найдена`);
    assertLaterDeadline(current.dueAt ?? new Date(0), command.dueAt);
    this.actions[actionIndex] = {
      ...current,
      dueAt: command.dueAt,
      group: current.group === "waiting" ? "waiting" : groupForDate(command.dueAt),
    };
    this.rescheduledToday += 1;
    const response = this.getToday();
    this.taskRescheduleIdempotency.set(scope, {
      requestHash,
      response: structuredClone(response),
    });
    return response;
  }

  createContact(organizationId: string, input: unknown, idempotencyKey: string): ContactOption {
    return this.contactRegistry.createContact(organizationId, input, idempotencyKey);
  }

  linkContact(
    organizationId: string,
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): ContactOption {
    return this.contactRegistry.linkContact(organizationId, contactId, input, idempotencyKey);
  }

  mergeContact(
    sourceContactId: string,
    input: unknown,
    idempotencyKey: string,
  ): MergeContactResult {
    return this.contactRegistry.mergeContact(sourceContactId, input, idempotencyKey);
  }

  listContacts(
    query: {
      search?: string;
      status?: string;
      organizationId?: string;
      duplicatesOnly?: boolean;
    } = {},
  ): ContactRegistryPayload {
    return this.contactRegistry.listContacts(query);
  }

  updateContact(contactId: string, input: unknown, idempotencyKey: string): ContactRegistryItem {
    return this.contactRegistry.updateContact(contactId, input, idempotencyKey);
  }

  archiveContact(contactId: string, input: unknown, idempotencyKey: string): ContactRegistryItem {
    return this.contactRegistry.archiveContact(contactId, input, idempotencyKey);
  }

  restoreContact(contactId: string, input: unknown, idempotencyKey: string): ContactRegistryItem {
    return this.contactRegistry.restoreContact(contactId, input, idempotencyKey);
  }

  private createNextAction(
    current: TodayAction,
    command: CompleteTaskCommand,
    contactName: string,
  ) {
    if (command.next.mode === "close") return;

    let dueAt: string;
    let title: string;
    let group: ActionGroup;
    let isWaiting: boolean;

    if (command.next.mode === "waiting") {
      dueAt = command.next.reviewAt;
      title = `Вернуться к ожиданию: ${command.next.waitingFor}`;
      group = "waiting";
      isWaiting = true;
    } else {
      dueAt = command.next.dueAt;
      title = command.next.title;
      group = groupForDate(dueAt);
      isWaiting = false;
    }
    const priority = calculatePriority({
      partnerScore: Math.max(45, current.priorityScore),
      isIntegrationOrPilot: ["S7", "S8"].includes(current.stageCode),
      isWaitingBeforeReview: isWaiting,
    });

    this.actions.push({
      ...current,
      opportunityVersion: current.opportunityVersion + 1,
      id: `task-next-${Date.now()}`,
      title,
      dueAt,
      group,
      priorityScore: priority.score,
      priorityReasons: priority.reasons,
      lastInteraction: {
        type: interactionTypeLabel(command.interactionType),
        occurredAt: new Date().toISOString(),
        contactName,
        summary: command.summary,
      },
    });
  }
}

function interactionTypeLabel(type: CompleteTaskCommand["interactionType"]) {
  return {
    email: "Письмо",
    call: "Звонок",
    meeting: "Встреча",
    messenger: "Мессенджер",
    note: "Заметка",
  }[type];
}

function groupForDate(dueAt: string): ActionGroup {
  const due = new Date(dueAt);
  return due <= endOfMoscowDay(new Date()) ? "today" : "later";
}

function sortActions(left: TodayAction, right: TodayAction) {
  const groupOrder: Record<ActionGroup, number> = {
    critical: 0,
    today: 1,
    later: 2,
    waiting: 3,
  };
  return (
    groupOrder[left.group] - groupOrder[right.group] || right.priorityScore - left.priorityScore
  );
}
