import { describe, expect, it } from "vitest";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { SessionPayload } from "@embed-os/contracts";
import { delay, firstValueFrom, map, of } from "rxjs";
import {
  ActorContextInterceptor,
  ActorExecutionContext,
} from "./actor-execution-context.js";

function actor(userId: string): SessionPayload {
  return {
    subject: `corp:${userId}`,
    userId,
    displayName: userId,
    initials: userId.slice(0, 2),
    email: null,
    role: "partner_manager",
    permissions: ["today.read"],
    scope: { mode: "own", teamId: "team-1", teamName: "Команда 1" },
  };
}

describe("ActorExecutionContext", () => {
  it("keeps concurrent request actors isolated across asynchronous work", async () => {
    const context = new ActorExecutionContext();
    const first = actor("user-1");
    const second = actor("user-2");

    const [firstSeen, secondSeen] = await Promise.all([
      context.run(first, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return context.current()?.userId;
      }),
      context.run(second, async () => context.current()?.userId),
    ]);

    expect(firstSeen).toBe("user-1");
    expect(secondSeen).toBe("user-2");
    expect(context.current()).toBeUndefined();
  });

  it("keeps the verified request actor while the handler observable executes", async () => {
    const context = new ActorExecutionContext();
    const requestActor = actor("user-3");
    const interceptor = new ActorContextInterceptor(context);
    const execution = {
      switchToHttp: () => ({ getRequest: () => ({ actor: requestActor }) }),
    } as unknown as ExecutionContext;
    const next = {
      handle: () => of(null).pipe(
        delay(1),
        map(() => context.current()?.userId),
      ),
    } satisfies CallHandler;

    await expect(firstValueFrom(interceptor.intercept(execution, next))).resolves.toBe("user-3");
    expect(context.current()).toBeUndefined();
  });
});
