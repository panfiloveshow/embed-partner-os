import { createHash } from "node:crypto";
import type {
  CompleteTaskCommand,
  CreateContactCommand,
  LinkContactCommand,
  MergeContactCommand,
  GenerateWeeklyReportCommand,
  RegisterPlacementCommand,
  UpdatePlacementCommand,
  ArchivePlacementCommand,
  TransitionOpportunityStageCommand,
  UpdateContactCommand,
  ChangeContactStatusCommand,
  RescheduleTaskCommand,
  UpdateSlaSettingsCommand,
  UpdateAccessUserCommand,
  CreateAccessUserCommand,
} from "@embed-os/contracts";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

export class IdempotencyKeyValidationError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REQUIRED";

  constructor() {
    super(
      "Передайте Idempotency-Key длиной 8–200 символов: латиница, цифры, точка, подчёркивание, двоеточие или дефис.",
    );
    this.name = "IdempotencyKeyValidationError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor(readonly idempotencyKey: string) {
    super("Этот Idempotency-Key уже использован с другим содержимым запроса.");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyInProgressError extends Error {
  readonly code = "IDEMPOTENCY_REQUEST_IN_PROGRESS";

  constructor(readonly idempotencyKey: string) {
    super("Запрос с этим Idempotency-Key ещё выполняется. Повторите попытку позднее.");
    this.name = "IdempotencyInProgressError";
  }
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw new IdempotencyKeyValidationError();
  const normalized = value.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new IdempotencyKeyValidationError();
  }
  return normalized;
}

export function completionRequestHash(command: CompleteTaskCommand): string {
  return requestHash(command);
}

export function taskRescheduleRequestHash(command: RescheduleTaskCommand): string {
  return requestHash(command);
}

export function contactRequestHash(command: CreateContactCommand): string {
  return requestHash(command);
}

export function linkContactRequestHash(command: LinkContactCommand): string {
  return requestHash(command);
}

export function mergeContactRequestHash(command: MergeContactCommand): string {
  return requestHash(command);
}

export function updateContactRequestHash(command: UpdateContactCommand): string {
  return requestHash(command);
}

export function contactStatusRequestHash(command: ChangeContactStatusCommand): string {
  return requestHash(command);
}

export function weeklyReportRequestHash(command: GenerateWeeklyReportCommand): string {
  return requestHash(command);
}

export function placementRequestHash(command: RegisterPlacementCommand): string {
  return requestHash(command);
}

export function placementCheckRequestHash(placementId: string, source: string): string {
  return requestHash({ placementId, source });
}

export function placementUpdateRequestHash(command: UpdatePlacementCommand): string {
  return requestHash(command);
}

export function placementArchiveRequestHash(command: ArchivePlacementCommand): string {
  return requestHash(command);
}

export function opportunityStageRequestHash(command: TransitionOpportunityStageCommand): string {
  return requestHash(command);
}

export function slaSettingsRequestHash(command: UpdateSlaSettingsCommand): string {
  return requestHash(command);
}

export function accessUserRequestHash(command: UpdateAccessUserCommand): string {
  return requestHash(command);
}

export function accessUserCreateRequestHash(command: CreateAccessUserCommand): string {
  return requestHash(command);
}

function requestHash(command: unknown): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}
