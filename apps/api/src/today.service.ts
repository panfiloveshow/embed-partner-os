import { randomUUID } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  ActionGroup,
  CompleteTaskCommand,
  ContactCandidate,
  ContactOption,
  ContactRegistryItem,
  ContactRegistryPayload,
  UpdateContactCommand,
  CreateContactCommand,
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
  parseCreateContactCommand,
  parseChangeContactStatusCommand,
  parseLinkContactCommand,
  parseMergeContactCommand,
  parseUpdateContactCommand,
  parseRescheduleTaskCommand,
  assertLaterDeadline,
} from "@embed-os/domain";
import {
  ContactDuplicateCandidatesError,
  ContactAlreadyLinkedError,
  ContactAlreadyMergedError,
  ContactMergeSameContactError,
  ContactMergeTargetRetiredError,
  ContactNotFoundError,
  ContactStateError,
  ContactVersionConflictError,
  OrganizationNotFoundError,
} from "./application/contact.js";
import { ContactNotAvailableError } from "./application/task-completion.service.js";
import {
  completionRequestHash,
  contactRequestHash,
  IdempotencyConflictError,
  parseIdempotencyKey,
  linkContactRequestHash,
  mergeContactRequestHash,
  contactStatusRequestHash,
  updateContactRequestHash,
  taskRescheduleRequestHash,
} from "./application/idempotency.js";
import type { TodayPort } from "./today.port.js";
import type { ContactPort } from "./contact.port.js";

interface SeedAction extends Omit<TodayAction, "priorityScore" | "priorityReasons"> {
  factors: Parameters<typeof calculatePriority>[0];
}

interface InMemoryContactProfile {
  id: string;
  version: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  messenger: string | null;
  source: string;
  verifiedAt: string | null;
  restrictions: string | null;
  archivedAt: string | null;
  updatedAt: string;
}

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
  private readonly contactIdempotency = new Map<
    string,
    { requestHash: string; response: ContactOption }
  >();
  private readonly contactLinkIdempotency = new Map<
    string,
    { requestHash: string; response: ContactOption }
  >();
  private readonly contactMergeIdempotency = new Map<
    string,
    { requestHash: string; response: MergeContactResult }
  >();
  private readonly contactMutationIdempotency = new Map<
    string,
    { requestHash: string; response: ContactRegistryItem }
  >();
  private readonly contactProfiles = new Map<string, InMemoryContactProfile>();
  private readonly mergedContacts = new Map<string, string>();

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
          contacts: action.contacts.filter((contact) => {
            const profile = this.contactProfiles.get(contact.id);
            return !profile?.archivedAt && !this.mergedContacts.has(contact.id);
          }),
        }))
        .sort(sortActions),
    };
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
      this.contactProfiles.set(id, profile);
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
    if (
      !contact ||
      this.contactProfiles.get(command.contactId)?.archivedAt ||
      this.mergedContacts.has(command.contactId)
    )
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
    const command = parseCreateContactCommand(input);
    const requestHash = contactRequestHash(command);
    const scope = `${organizationId}:${idempotencyKey}`;
    const replay = this.contactIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return structuredClone(replay.response);
    }

    const organizationActions = this.actions.filter(
      (action) => action.organizationId === organizationId,
    );
    if (organizationActions.length === 0) throw new OrganizationNotFoundError(organizationId);

    const duplicates = duplicateCandidates(this.actions, organizationId, command);
    if (duplicates.length > 0) throw new ContactDuplicateCandidatesError(duplicates);

    const contact: ContactOption = {
      id: `contact-${randomUUID()}`,
      fullName: command.fullName,
      role: command.role,
      department: command.department ?? null,
      email: command.email ?? null,
      phone: command.phone ?? null,
      messenger: command.messenger ?? null,
      isPrimary: organizationActions.every((action) => action.contacts.length === 0),
    };
    const now = new Date().toISOString();
    this.contactProfiles.set(contact.id, {
      id: contact.id,
      version: 1,
      fullName: contact.fullName,
      email: contact.email,
      phone: contact.phone,
      messenger: contact.messenger,
      source: command.source ?? "web",
      verifiedAt: command.verifiedAt ?? null,
      restrictions: command.restrictions ?? null,
      archivedAt: null,
      updatedAt: now,
    });
    for (const action of organizationActions) action.contacts.push(contact);
    this.contactIdempotency.set(scope, {
      requestHash,
      response: structuredClone(contact),
    });
    return structuredClone(contact);
  }

  linkContact(
    organizationId: string,
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): ContactOption {
    const command = parseLinkContactCommand(input);
    const requestHash = linkContactRequestHash(command);
    const scope = `${organizationId}:${contactId}:${idempotencyKey}`;
    const replay = this.contactLinkIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return structuredClone(replay.response);
    }

    const mergedIntoId = this.mergedContacts.get(contactId);
    if (mergedIntoId) throw new ContactAlreadyMergedError(contactId, mergedIntoId);

    const organizationActions = this.actions.filter(
      (action) => action.organizationId === organizationId,
    );
    if (organizationActions.length === 0) throw new OrganizationNotFoundError(organizationId);
    const source = this.actions
      .flatMap((action) => action.contacts)
      .find((contact) => contact.id === contactId);
    if (!source) throw new ContactNotFoundError(contactId);
    if (organizationActions.some((action) => action.contacts.some(({ id }) => id === contactId))) {
      throw new ContactAlreadyLinkedError(contactId, organizationId);
    }

    const linked: ContactOption = {
      id: source.id,
      fullName: source.fullName,
      role: command.role,
      department: command.department ?? null,
      email: source.email,
      phone: source.phone,
      messenger: source.messenger,
      isPrimary: organizationActions.every((action) => action.contacts.length === 0),
    };
    for (const action of organizationActions) action.contacts.push(linked);
    this.contactLinkIdempotency.set(scope, {
      requestHash,
      response: structuredClone(linked),
    });
    return structuredClone(linked);
  }

  mergeContact(
    sourceContactId: string,
    input: unknown,
    idempotencyKey: string,
  ): MergeContactResult {
    const command = parseMergeContactCommand(input);
    const requestHash = mergeContactRequestHash(command);
    const scope = `${sourceContactId}:${idempotencyKey}`;
    const replay = this.contactMergeIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return structuredClone(replay.response);
    }

    if (sourceContactId === command.targetContactId) {
      throw new ContactMergeSameContactError(sourceContactId);
    }
    const currentTargetId = this.mergedContacts.get(sourceContactId);
    if (currentTargetId) throw new ContactAlreadyMergedError(sourceContactId, currentTargetId);
    const retiredTargetId = this.mergedContacts.get(command.targetContactId);
    if (retiredTargetId) {
      throw new ContactMergeTargetRetiredError(command.targetContactId, retiredTargetId);
    }

    this.ensureContactProfiles();
    const allContacts = this.actions.flatMap((action) => action.contacts);
    const source = allContacts.find(({ id }) => id === sourceContactId);
    const target = allContacts.find(({ id }) => id === command.targetContactId);
    if (!source) throw new ContactNotFoundError(sourceContactId);
    if (!target) throw new ContactNotFoundError(command.targetContactId);

    let movedOrganizationLinks = 0;
    let closedConflictingLinks = 0;
    const organizationIds = new Set(
      this.actions
        .filter((action) => action.contacts.some(({ id }) => id === sourceContactId))
        .map((action) => action.organizationId),
    );
    for (const organizationId of organizationIds) {
      const organizationActions = this.actions.filter(
        (action) => action.organizationId === organizationId,
      );
      const sourceLink = organizationActions
        .flatMap((action) => action.contacts)
        .find(({ id }) => id === sourceContactId);
      if (!sourceLink) continue;
      const targetIsLinked = organizationActions.some((action) =>
        action.contacts.some(({ id }) => id === command.targetContactId),
      );

      for (const action of organizationActions) {
        action.contacts = action.contacts.filter(({ id }) => id !== sourceContactId);
        if (!targetIsLinked) {
          action.contacts.push({
            ...target,
            role: sourceLink.role,
            department: sourceLink.department,
            isPrimary: sourceLink.isPrimary,
          });
        }
      }
      if (targetIsLinked) closedConflictingLinks += 1;
      else movedOrganizationLinks += 1;
    }

    for (const [retiredContactId, currentTargetId] of this.mergedContacts) {
      if (currentTargetId === sourceContactId) {
        this.mergedContacts.set(retiredContactId, command.targetContactId);
      }
    }
    this.mergedContacts.set(sourceContactId, command.targetContactId);
    const result: MergeContactResult = {
      sourceContactId,
      targetContactId: command.targetContactId,
      movedOrganizationLinks,
      closedConflictingLinks,
      movedInteractions: 0,
      outboxEventId: `event-${randomUUID()}`,
    };
    this.contactMergeIdempotency.set(scope, {
      requestHash,
      response: structuredClone(result),
    });
    return structuredClone(result);
  }

  listContacts(
    query: {
      search?: string;
      status?: string;
      organizationId?: string;
      duplicatesOnly?: boolean;
    } = {},
  ): ContactRegistryPayload {
    this.ensureContactProfiles();
    const organizations = uniqueOrganizations(this.actions);
    const normalizedSearch = query.search?.trim().toLocaleLowerCase("ru");
    const requestedStatus = query.status ?? "active";
    const contacts = [...this.contactProfiles.values()]
      .map((profile) => this.contactRegistryItem(profile))
      .filter((contact) => requestedStatus === "all" || contact.status === requestedStatus)
      .filter(
        (contact) =>
          !query.organizationId ||
          contact.organizationLinks.some(
            ({ organizationId }) => organizationId === query.organizationId,
          ),
      )
      .filter((contact) => !query.duplicatesOnly || contact.duplicateMatches.length > 0)
      .filter((contact) => {
        if (!normalizedSearch) return true;
        return [
          contact.fullName,
          contact.email,
          contact.phone,
          contact.messenger,
          ...contact.organizationLinks.flatMap((link) => [
            link.organizationName,
            link.role,
            link.department,
          ]),
        ].some((value) => value?.toLocaleLowerCase("ru").includes(normalizedSearch));
      })
      .sort((left, right) => left.fullName.localeCompare(right.fullName, "ru"));
    return {
      generatedAt: new Date().toISOString(),
      total: contacts.length,
      truncated: contacts.length > 200,
      organizations,
      contacts: structuredClone(contacts.slice(0, 200)),
    };
  }

  updateContact(contactId: string, input: unknown, idempotencyKey: string): ContactRegistryItem {
    const command = parseUpdateContactCommand(input);
    return this.runContactMutation(
      `update:${contactId}:${idempotencyKey}`,
      updateContactRequestHash(command),
      idempotencyKey,
      () => {
        this.ensureContactProfiles();
        const profile = this.activeContactProfile(contactId, command.version);
        const duplicates = duplicateProfiles(this.contactProfiles, contactId, command);
        if (duplicates.length > 0) throw new ContactDuplicateCandidatesError(duplicates);

        if (command.organizationLink) {
          const prefix = `contact-link:${contactId}:`;
          if (!command.organizationLink.id.startsWith(prefix)) {
            throw new ContactStateError("Связь контакта с организацией не найдена.");
          }
          const organizationId = command.organizationLink.id.slice(prefix.length);
          let changed = false;
          for (const action of this.actions) {
            if (action.organizationId !== organizationId) continue;
            action.contacts = action.contacts.map((contact) => {
              if (contact.id !== contactId) return contact;
              changed = true;
              return {
                ...contact,
                role: command.organizationLink?.role ?? contact.role,
                department: command.organizationLink?.department ?? null,
              };
            });
          }
          if (!changed) throw new ContactStateError("Связь контакта с организацией не найдена.");
        }

        profile.fullName = command.fullName;
        profile.email = command.email ?? null;
        profile.phone = command.phone ?? null;
        profile.messenger = command.messenger ?? null;
        profile.source = command.source;
        profile.verifiedAt = command.verifiedAt ?? null;
        profile.restrictions = command.restrictions ?? null;
        profile.version += 1;
        profile.updatedAt = new Date().toISOString();
        for (const action of this.actions) {
          action.contacts = action.contacts.map((contact) =>
            contact.id === contactId
              ? {
                  ...contact,
                  fullName: profile.fullName,
                  email: profile.email,
                  phone: profile.phone,
                  messenger: profile.messenger,
                }
              : contact,
          );
        }
        return this.contactRegistryItem(profile);
      },
    );
  }

  archiveContact(contactId: string, input: unknown, idempotencyKey: string): ContactRegistryItem {
    return this.changeContactArchived(contactId, input, idempotencyKey, true);
  }

  restoreContact(contactId: string, input: unknown, idempotencyKey: string): ContactRegistryItem {
    return this.changeContactArchived(contactId, input, idempotencyKey, false);
  }

  private changeContactArchived(
    contactId: string,
    input: unknown,
    idempotencyKey: string,
    archived: boolean,
  ) {
    const command = parseChangeContactStatusCommand(input);
    return this.runContactMutation(
      `${archived ? "archive" : "restore"}:${contactId}:${idempotencyKey}`,
      contactStatusRequestHash(command),
      idempotencyKey,
      () => {
        this.ensureContactProfiles();
        const profile = this.contactProfiles.get(contactId);
        if (!profile) throw new ContactNotFoundError(contactId);
        if (this.mergedContacts.has(contactId)) {
          throw new ContactStateError(
            "Объединённый контакт нельзя архивировать или восстанавливать.",
          );
        }
        if (profile.version !== command.version) {
          throw new ContactVersionConflictError(contactId, profile.version);
        }
        if (Boolean(profile.archivedAt) === archived) {
          throw new ContactStateError(
            archived ? "Контакт уже архивирован." : "Контакт уже активен.",
          );
        }
        profile.archivedAt = archived ? new Date().toISOString() : null;
        profile.version += 1;
        profile.updatedAt = new Date().toISOString();
        return this.contactRegistryItem(profile);
      },
    );
  }

  private runContactMutation(
    scope: string,
    requestHash: string,
    idempotencyKey: string,
    mutate: () => ContactRegistryItem,
  ) {
    const replay = this.contactMutationIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const response = mutate();
    this.contactMutationIdempotency.set(scope, {
      requestHash,
      response: structuredClone(response),
    });
    return structuredClone(response);
  }

  private activeContactProfile(contactId: string, version: number) {
    const profile = this.contactProfiles.get(contactId);
    if (!profile) throw new ContactNotFoundError(contactId);
    if (this.mergedContacts.has(contactId)) throw new ContactStateError("Контакт уже объединён.");
    if (profile.archivedAt)
      throw new ContactStateError("Архивный контакт сначала нужно восстановить.");
    if (profile.version !== version)
      throw new ContactVersionConflictError(contactId, profile.version);
    return profile;
  }

  private ensureContactProfiles() {
    for (const contact of this.actions.flatMap((action) => action.contacts)) {
      if (this.contactProfiles.has(contact.id)) continue;
      this.contactProfiles.set(contact.id, {
        id: contact.id,
        version: 1,
        fullName: contact.fullName,
        email: contact.email,
        phone: contact.phone,
        messenger: contact.messenger,
        source: "Демонстрационные данные",
        verifiedAt: "2026-08-15T11:32:00.000Z",
        restrictions: null,
        archivedAt: null,
        updatedAt: "2026-08-15T11:32:00.000Z",
      });
    }
  }

  private contactRegistryItem(profile: InMemoryContactProfile): ContactRegistryItem {
    const links = uniqueContactLinks(this.actions, profile.id);
    return {
      ...profile,
      status: this.mergedContacts.has(profile.id)
        ? "merged"
        : profile.archivedAt
          ? "archived"
          : "active",
      mergedIntoId: this.mergedContacts.get(profile.id) ?? null,
      organizationLinks: links,
      duplicateMatches: duplicateMatches(this.contactProfiles, profile.id).filter(
        ({ contactId }) => !this.mergedContacts.has(contactId),
      ),
    };
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

function uniqueOrganizations(actions: TodayAction[]) {
  const organizations = new Map<string, string>();
  for (const action of actions) organizations.set(action.organizationId, action.organizationName);
  return [...organizations]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function uniqueContactLinks(actions: TodayAction[], contactId: string) {
  const links = new Map<string, ContactRegistryItem["organizationLinks"][number]>();
  for (const action of actions) {
    const contact = action.contacts.find(({ id }) => id === contactId);
    if (!contact || links.has(action.organizationId)) continue;
    links.set(action.organizationId, {
      id: `contact-link:${contactId}:${action.organizationId}`,
      organizationId: action.organizationId,
      organizationName: action.organizationName,
      role: contact.role,
      department: contact.department,
      isPrimary: contact.isPrimary,
      validFrom: "2026-08-15T11:32:00.000Z",
      validTo: null,
    });
  }
  return [...links.values()].sort((left, right) =>
    left.organizationName.localeCompare(right.organizationName, "ru"),
  );
}

function duplicateMatches(profiles: Map<string, InMemoryContactProfile>, contactId: string) {
  const source = profiles.get(contactId);
  if (!source) return [];
  return [...profiles.values()]
    .filter((candidate) => candidate.id !== contactId && !candidate.archivedAt)
    .map((candidate) => ({
      contactId: candidate.id,
      fullName: candidate.fullName,
      matchedOn: [
        source.email && source.email === candidate.email ? "email" : null,
        source.phone && source.phone === candidate.phone ? "phone" : null,
        source.messenger && source.messenger === candidate.messenger ? "messenger" : null,
      ].filter(Boolean) as Array<"email" | "phone" | "messenger">,
    }))
    .filter(({ matchedOn }) => matchedOn.length > 0);
}

function duplicateProfiles(
  profiles: Map<string, InMemoryContactProfile>,
  contactId: string,
  command: UpdateContactCommand,
): ContactCandidate[] {
  return [...profiles.values()]
    .filter((candidate) => candidate.id !== contactId && !candidate.archivedAt)
    .filter(
      (candidate) =>
        (command.email && command.email === candidate.email) ||
        (command.phone && command.phone === candidate.phone) ||
        (command.messenger && command.messenger === candidate.messenger),
    )
    .map((candidate) => ({
      id: candidate.id,
      fullName: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      messenger: candidate.messenger,
      isLinkedToOrganization: false,
    }));
}

function duplicateCandidates(
  actions: TodayAction[],
  organizationId: string,
  command: CreateContactCommand,
): ContactCandidate[] {
  const contacts = new Map<string, ContactOption>();
  for (const action of actions) {
    for (const contact of action.contacts) contacts.set(contact.id, contact);
  }
  return [...contacts.values()]
    .filter(
      (contact) =>
        (command.email && contact.email === command.email) ||
        (command.phone && contact.phone === command.phone) ||
        (command.messenger && contact.messenger === command.messenger),
    )
    .map(({ id, fullName, email, phone, messenger }) => ({
      id,
      fullName,
      email,
      phone,
      messenger,
      isLinkedToOrganization: actions.some(
        (action) =>
          action.organizationId === organizationId &&
          action.contacts.some((contact) => contact.id === id),
      ),
    }));
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

const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Moscow calendar date the seed dataset below was authored for. */
const SEED_ANCHOR_DATE = "2026-08-17";

function startOfMoscowDay(now: Date): Date {
  const moscow = new Date(now.getTime() + MOSCOW_UTC_OFFSET_MS);
  const startLocalAsUtc = Date.UTC(
    moscow.getUTCFullYear(),
    moscow.getUTCMonth(),
    moscow.getUTCDate(),
  );
  return new Date(startLocalAsUtc - MOSCOW_UTC_OFFSET_MS);
}

function endOfMoscowDay(now: Date): Date {
  return new Date(startOfMoscowDay(now).getTime() + DAY_MS - 1);
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

function buildSeedActions(): TodayAction[] {
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
