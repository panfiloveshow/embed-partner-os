import { Injectable } from "@nestjs/common";
import type { SlaSettingsPayload } from "@embed-os/contracts";
import {
  defaultSlaThresholds,
  parseUpdateSlaSettingsCommand,
  slaSettingsFromProcessDefinition,
} from "@embed-os/domain";
import {
  IdempotencyConflictError,
  slaSettingsRequestHash,
} from "./application/idempotency.js";
import type { SlaSettingsPort } from "./sla-settings.port.js";

export class SlaSettingsVersionConflictError extends Error {
  readonly code = "SLA_SETTINGS_VERSION_CONFLICT";

  constructor(readonly currentVersion: number) {
    super(`Настройки SLA уже изменены. Актуальная версия: ${currentVersion}`);
    this.name = "SlaSettingsVersionConflictError";
  }
}

@Injectable()
export class SlaSettingsService implements SlaSettingsPort {
  private current = slaSettingsFromProcessDefinition({
    id: "memory-process-1",
    version: 1,
    publishedAt: new Date("2026-08-17T06:00:00.000Z"),
    schema: {
      sla: { escalationAfterDays: 3, thresholds: defaultSlaThresholds },
    },
    affectedOpportunities: 16,
  });
  private readonly idempotency = new Map<
    string,
    { requestHash: string; response: SlaSettingsPayload }
  >();

  async get(): Promise<SlaSettingsPayload> {
    return structuredClone(this.current);
  }

  async update(
    actorId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<SlaSettingsPayload> {
    const command = parseUpdateSlaSettingsCommand(input);
    const requestHash = slaSettingsRequestHash(command);
    const scope = `${actorId}:${idempotencyKey}`;
    const replay = this.idempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    if (command.version !== this.current.version) {
      throw new SlaSettingsVersionConflictError(this.current.version);
    }
    const thresholds = Object.fromEntries(
      this.current.stages.map(({ code }) => [code, command.thresholds[code]]),
    );
    this.current = slaSettingsFromProcessDefinition({
      id: `memory-process-${this.current.version + 1}`,
      version: this.current.version + 1,
      publishedAt: new Date(),
      schema: {
        sla: { escalationAfterDays: command.escalationAfterDays, thresholds },
      },
      affectedOpportunities: this.current.affectedOpportunities,
    });
    const response = structuredClone(this.current);
    this.idempotency.set(scope, { requestHash, response });
    return structuredClone(response);
  }
}
