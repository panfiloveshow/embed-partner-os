import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { ActorRole, SessionPayload } from "@embed-os/contracts";
import { ActorExecutionContext } from "../auth/actor-execution-context.js";
import { PrismaService } from "./prisma.service.js";

export const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000001";

export interface PersistenceActor {
  id: string;
  subject: string;
  displayName: string;
  role: ActorRole;
  scopeMode: SessionPayload["scope"]["mode"];
  teamId: string | null;
  teamName: string | null;
}

type UserClient = Pick<PrismaService, "user"> | Pick<Prisma.TransactionClient, "user">;

@Injectable()
export class PersistenceActorService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ActorExecutionContext) private readonly context: ActorExecutionContext,
  ) {}

  /**
   * Actor of the current HTTP request. Fails closed: a request that reached
   * persistence without a verified session is a configuration error, never
   * an implicit administrator.
   */
  async current(client: UserClient = this.prisma): Promise<PersistenceActor> {
    const session = this.context.current();
    if (!session) {
      throw new UnauthorizedException(
        "Запрос выполняется без проверенной сессии. Доступ к данным запрещён",
      );
    }
    const user = await this.loadUser(client, session.userId);
    if (!user || user.status !== "ACTIVE") {
      throw new ServiceUnavailableException("Пользователь авторизации отсутствует или отключён");
    }
    return {
      id: user.id,
      subject: session.subject,
      displayName: user.displayName,
      role: session.role,
      scopeMode: session.scope.mode,
      teamId: user.teamId,
      teamName: user.team?.name ?? null,
    };
  }

  /**
   * Explicit system actor for background workers that legitimately run
   * without an HTTP session (outbox relays, monitors, schedulers).
   */
  async systemActor(client: UserClient = this.prisma): Promise<PersistenceActor> {
    const user = await this.loadUser(client, SYSTEM_ACTOR_ID);
    if (!user || user.status !== "ACTIVE") {
      throw new ServiceUnavailableException(
        "Системный пользователь отсутствует. Выполните npm run db:seed",
      );
    }
    return {
      id: user.id,
      subject: user.externalSubject,
      displayName: user.displayName,
      role: "admin",
      scopeMode: "all",
      teamId: user.teamId,
      teamName: user.team?.name ?? null,
    };
  }

  /**
   * For code paths shared by HTTP handlers and background workers: uses the
   * request session when present, otherwise the explicit system actor.
   */
  async currentOrSystem(client: UserClient = this.prisma): Promise<PersistenceActor> {
    return this.context.current() ? this.current(client) : this.systemActor(client);
  }

  private async loadUser(client: UserClient, id: string) {
    return client.user.findUnique({
      where: { id },
      select: {
        id: true,
        externalSubject: true,
        displayName: true,
        status: true,
        teamId: true,
        team: { select: { name: true } },
      },
    });
  }
}

export function requireActorTeam(actor: PersistenceActor): string {
  if (!actor.teamId) {
    throw new ServiceUnavailableException("Для пользователя не назначена команда");
  }
  return actor.teamId;
}

export function opportunityScope(actor: PersistenceActor): Prisma.OpportunityWhereInput {
  if (actor.scopeMode === "all") return {};
  if (actor.scopeMode === "team") return { owner: { teamId: requireActorTeam(actor) } };
  return { ownerId: actor.id };
}

export function organizationScope(actor: PersistenceActor): Prisma.OrganizationWhereInput {
  if (actor.scopeMode === "all") return {};
  if (actor.scopeMode === "team") {
    const teamId = requireActorTeam(actor);
    return {
      OR: [
        { owner: { teamId } },
        { opportunities: { some: { archivedAt: null, owner: { teamId } } } },
      ],
    };
  }
  return {
    OR: [
      { ownerId: actor.id },
      { opportunities: { some: { archivedAt: null, ownerId: actor.id } } },
    ],
  };
}

export function contactScope(actor: PersistenceActor): Prisma.ContactWhereInput {
  if (actor.scopeMode === "all") return {};
  return {
    organizationLinks: {
      some: {
        validTo: null,
        organization: { is: organizationScope(actor) },
      },
    },
  };
}

export function taskScope(actor: PersistenceActor): Prisma.TaskWhereInput {
  if (actor.scopeMode === "all") return {};
  if (actor.scopeMode === "team") return { owner: { teamId: requireActorTeam(actor) } };
  return { ownerId: actor.id };
}

export function placementScope(actor: PersistenceActor): Prisma.PlacementWhereInput {
  if (actor.scopeMode === "all") return {};
  if (actor.scopeMode === "team") return { owner: { teamId: requireActorTeam(actor) } };
  return { ownerId: actor.id };
}

export function radarCandidateScope(actor: PersistenceActor): Prisma.RadarCandidateWhereInput {
  if (actor.scopeMode === "all") return {};
  if (actor.scopeMode === "team") return { teamId: requireActorTeam(actor) };
  return { createdById: actor.id };
}

export function importJobScope(actor: PersistenceActor): Prisma.ImportJobWhereInput {
  if (actor.scopeMode === "all") return {};
  if (actor.scopeMode === "team") return { teamId: requireActorTeam(actor) };
  return { actorId: actor.id };
}
