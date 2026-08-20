import { randomUUID } from "node:crypto";
import type {
  ContactCandidate,
  ContactOption,
  ContactRegistryItem,
  ContactRegistryPayload,
  CreateContactCommand,
  MergeContactResult,
  TodayAction,
  UpdateContactCommand,
} from "@embed-os/contracts";
import {
  parseChangeContactStatusCommand,
  parseCreateContactCommand,
  parseLinkContactCommand,
  parseMergeContactCommand,
  parseUpdateContactCommand,
} from "@embed-os/domain";
import {
  ContactAlreadyLinkedError,
  ContactAlreadyMergedError,
  ContactDuplicateCandidatesError,
  ContactMergeSameContactError,
  ContactMergeTargetRetiredError,
  ContactNotFoundError,
  ContactStateError,
  ContactVersionConflictError,
  OrganizationNotFoundError,
} from "./application/contact.js";
import {
  contactRequestHash,
  contactStatusRequestHash,
  IdempotencyConflictError,
  linkContactRequestHash,
  mergeContactRequestHash,
  updateContactRequestHash,
} from "./application/idempotency.js";
import type { ContactPort } from "./contact.port.js";

export interface InMemoryContactProfile {
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

/**
 * In-memory contact registry backing the demo `TodayService`. Contact links
 * live inside the shared actions array, so the registry reads it through the
 * `actionsSource` accessor supplied by the owning service.
 */
export class ContactRegistryService implements ContactPort {
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

  constructor(private readonly actionsSource: () => TodayAction[]) {}

  private get actions(): TodayAction[] {
    return this.actionsSource();
  }

  /** A contact is available while it is neither archived nor merged away. */
  isContactAvailable(contactId: string): boolean {
    return !this.contactProfiles.get(contactId)?.archivedAt && !this.mergedContacts.has(contactId);
  }

  registerProfile(profile: InMemoryContactProfile): void {
    this.contactProfiles.set(profile.id, profile);
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
