import type { ContactCandidate } from "@embed-os/contracts";

export class ContactDuplicateCandidatesError extends Error {
  readonly code = "CONTACT_DUPLICATE_CANDIDATES";

  constructor(readonly candidates: ContactCandidate[]) {
    super("Найдены контакты с совпадающим email, телефоном или мессенджером.");
    this.name = "ContactDuplicateCandidatesError";
  }
}

export class OrganizationNotFoundError extends Error {
  readonly code = "ORGANIZATION_NOT_FOUND";

  constructor(readonly organizationId: string) {
    super(`Организация ${organizationId} не найдена.`);
    this.name = "OrganizationNotFoundError";
  }
}

export class ContactNotFoundError extends Error {
  readonly code = "CONTACT_NOT_FOUND";

  constructor(readonly contactId: string) {
    super(`Контакт ${contactId} не найден.`);
    this.name = "ContactNotFoundError";
  }
}

export class ContactAlreadyLinkedError extends Error {
  readonly code = "CONTACT_ALREADY_LINKED";

  constructor(readonly contactId: string, readonly organizationId: string) {
    super("Контакт уже связан с этой организацией.");
    this.name = "ContactAlreadyLinkedError";
  }
}

export class ContactMergeSameContactError extends Error {
  readonly code = "CONTACT_MERGE_SAME_CONTACT";

  constructor(readonly contactId: string) {
    super("Исходный и целевой контакт должны отличаться.");
    this.name = "ContactMergeSameContactError";
  }
}

export class ContactAlreadyMergedError extends Error {
  readonly code = "CONTACT_ALREADY_MERGED";

  constructor(readonly contactId: string, readonly targetContactId: string) {
    super(`Контакт ${contactId} уже объединён с контактом ${targetContactId}.`);
    this.name = "ContactAlreadyMergedError";
  }
}

export class ContactMergeTargetRetiredError extends Error {
  readonly code = "CONTACT_MERGE_TARGET_RETIRED";

  constructor(readonly contactId: string, readonly targetContactId: string) {
    super(`Целевой контакт ${contactId} уже объединён с контактом ${targetContactId}.`);
    this.name = "ContactMergeTargetRetiredError";
  }
}

export class ContactVersionConflictError extends Error {
  readonly code = "CONTACT_VERSION_CONFLICT";

  constructor(readonly contactId: string, readonly currentVersion: number) {
    super(`Контакт ${contactId} уже изменён. Обновите данные и повторите действие.`);
    this.name = "ContactVersionConflictError";
  }
}

export class ContactStateError extends Error {
  readonly code = "CONTACT_STATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ContactStateError";
  }
}
