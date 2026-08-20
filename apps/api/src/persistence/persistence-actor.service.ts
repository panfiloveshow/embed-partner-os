import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
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

  async current(client: UserClient = this.prisma): Promise<PersistenceActor> {
    const session = this.context.current();
    const id = session?.userId ?? SYSTEM_ACTOR_ID;
    const user = await client.user.findUnique({
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
    if (!user || user.status !== "ACTIVE") {
      throw new ServiceUnavailableException(
        session
          ? "Пользователь авторизации отсутствует или отключён"
          : "Системный пользователь отсутствует. Выполните npm run db:seed",
      );
    }
    return {
      id: user.id,
      subject: session?.subject ?? user.externalSubject,
      displayName: user.displayName,
      role: session?.role ?? "admin",
      scopeMode: session?.scope.mode ?? "all",
      teamId: user.teamId,
      teamName: user.team?.name ?? null,
    };
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
