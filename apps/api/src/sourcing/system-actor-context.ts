import type { SessionPayload } from "@embed-os/contracts";
import type { ActorExecutionContext } from "../auth/actor-execution-context.js";
import type { PersistenceActorService } from "../persistence/persistence-actor.service.js";

/**
 * Builds a runner that executes radar mutations under the explicit system
 * actor. The postgres Radar service resolves its actor from the
 * ActorExecutionContext (normally filled by the HTTP interceptor); background
 * sourcing has no session, so it enters the context with a synthetic system
 * session before calling the same service methods — audit, outbox and scope
 * behave exactly like for a manual request.
 */
export function createSystemContextRunner(
  actors: PersistenceActorService,
  context: ActorExecutionContext,
): <T>(action: () => Promise<T>) => Promise<T> {
  return async (action) => {
    const system = await actors.systemActor();
    const session: SessionPayload = {
      subject: system.subject,
      userId: system.id,
      displayName: system.displayName,
      initials: "SY",
      email: null,
      role: "admin",
      permissions: ["radar.read", "radar.write"],
      scope: { mode: "all", teamId: system.teamId, teamName: system.teamName },
    };
    return context.run(session, action);
  };
}
