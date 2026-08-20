import type { SlaSettingsPayload } from "@embed-os/contracts";

export const SLA_SETTINGS_PORT = Symbol("SLA_SETTINGS_PORT");

export interface SlaSettingsPort {
  get(): Promise<SlaSettingsPayload>;
  update(actorId: string, input: unknown, idempotencyKey: string): Promise<SlaSettingsPayload>;
}
