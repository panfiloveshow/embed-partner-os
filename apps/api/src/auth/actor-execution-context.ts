import { AsyncLocalStorage } from "node:async_hooks";
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { SessionPayload } from "@embed-os/contracts";
import { Observable } from "rxjs";
import type { ActorRequest } from "./access-control.js";

/**
 * Carries the actor verified by AccessControlGuard through application and
 * persistence calls without forcing the HTTP request into every port method.
 */
@Injectable()
export class ActorExecutionContext {
  private readonly storage = new AsyncLocalStorage<SessionPayload>();

  run<T>(actor: SessionPayload, callback: () => T): T {
    return this.storage.run(actor, callback);
  }

  current(): SessionPayload | undefined {
    return this.storage.getStore();
  }
}

@Injectable()
export class ActorContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(ActorExecutionContext)
    private readonly actors: ActorExecutionContext,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<ActorRequest>();
    if (!request.actor) return next.handle();
    return new Observable((subscriber) => this.actors.run(
      request.actor!,
      () => next.handle().subscribe(subscriber),
    ));
  }
}
