import type { TodayPayload } from "@embed-os/contracts";

export const TODAY_PORT = Symbol("TODAY_PORT");

export interface TodayPort {
  getToday(): TodayPayload | Promise<TodayPayload>;
  completeTask(
    taskId: string,
    input: unknown,
    idempotencyKey: string,
  ): TodayPayload | Promise<TodayPayload>;
  rescheduleTask(
    taskId: string,
    input: unknown,
    idempotencyKey: string,
  ): TodayPayload | Promise<TodayPayload>;
}
