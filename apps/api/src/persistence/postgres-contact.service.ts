import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ContactCandidate,
  ContactOption,
  ContactRegistryItem,
  ContactRegistryPayload,
  MergeContactResult,
} from "@embed-os/contracts";
import {
  parseChangeContactStatusCommand,
  parseCreateContactCommand,
  parseLinkContactCommand,
  parseMergeContactCommand,
  parseUpdateContactCommand,
} from "@embed-os/domain";
import {
  ContactAlreadyLinkedError,
  ContactAlreadyMergedError,
  ContactDuplicateCandidatesError,
  ContactMergeSameContactError,
  ContactMergeTargetRetiredError,
  ContactNotFoundError,
  ContactStateError,
  ContactVersionConflictError,
  OrganizationNotFoundError,
} from "../application/contact.js";
import {
  contactRequestHash,
  contactStatusRequestHash,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  linkContactRequestHash,
  mergeContactRequestHash,
  updateContactRequestHash,
} from "../application/idempotency.js";
import type { ContactPort } from "../contact.port.js";
import {
  contactScope,
  organizationScope,
  PersistenceActorService,
  type PersistenceActor,
} from "./persistence-actor.service.js";
import { PrismaService } from "./prisma.service.js";

const contactRegistryInclude = Prisma.validator<Prisma.ContactInclude>()({
  organizationLinks: {
    orderBy: [{ isPrimary: "desc" }, { validFrom: "asc" }],
    include: {
      organization: { select: { id: true, name: true } },
    },
  },
});

type ContactRegistryRecord = Prisma.ContactGetPayload<{
  include: typeof contactRegistryInclude;
}>;

@Injectable()
export class PostgresContactService implements ContactPort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PersistenceActorService) private readonly actors: PersistenceActorService,
  ) {}

  async listContacts(
    query: {
      search?: string;
      status?: string;
      organizationId?: string;
      duplicatesOnly?: boolean;
    } = {},
  ): Promise<ContactRegistryPayload> {
    const actor = await this.actors.current();
    const where = contactRegistryWhere(query, actor);
    const [records, total, organizations, duplicatePool] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        include: contactRegistryInclude,
        orderBy: [{ fullName: "asc" }, { id: "asc" }],
        take: 201,
      }),
      this.prisma.contact.count({ where }),
      this.prisma.organization.findMany({
        where: { archivedAt: null, ...organizationScope(actor) },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: 500,
      }),
      this.prisma.contact.findMany({
        where: { archivedAt: null, mergedIntoId: null, ...contactScope(actor) },
        select: { id: true, fullName: true, email: true, phone: true, messenger: true },
        take: 1_000,
      }),
    ]);
    const visibleOrganizationIds = new Set(organizations.map(({ id }) => id));
    let contacts = records
      .slice(0, 200)
      .map((record) => toContactRegistryItem(record, duplicatePool, visibleOrganizationIds));
    if (query.duplicatesOnly) {
      contacts = contacts.filter(({ duplicateMatches }) => duplicateMatches.length > 0);
    }
    return {
      generatedAt: new Date().toISOString(),
      total: query.duplicatesOnly ? contacts.length : total,
      truncated: records.length > 200,
      organizations,
      contacts,
    };
  }

  async createContact(
    organizationId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ContactOption> {
    const command = parseCreateContactCommand(input);
    const requestHash = contactRequestHash(command);
    const operation = `contact.create:${organizationId}`;
    const now = new Date();
    const reservationId = randomUUID();

    return this.prisma.$transaction(
      async (transaction) => {
        const actor = await this.actors.current(transaction);
        const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "idempotency_record" (
            "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
          ) VALUES (
            ${reservationId}::uuid,
            ${actor.id}::uuid,
            ${operation},
            ${idempotencyKey},
            ${requestHash},
            ${now},
            ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)}
          )
          ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
          RETURNING "id"
        `);

        if (inserted.length === 0) {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              actorId_operation_requestKey: {
                actorId: actor.id,
                operation,
                requestKey: idempotencyKey,
              },
            },
          });
          if (!existing) throw new IdempotencyInProgressError(idempotencyKey);
          if (existing.requestHash !== requestHash) {
            throw new IdempotencyConflictError(idempotencyKey);
          }
          const replay = parseContactOption(existing.responseJson);
          if (!replay) throw new IdempotencyInProgressError(idempotencyKey);
          return replay;
        }

        const organization = await transaction.organization.findFirst({
          where: { id: organizationId, archivedAt: null, ...organizationScope(actor) },
          select: { id: true },
        });
        if (!organization) throw new OrganizationNotFoundError(organizationId);

        const channelLocks = [
          command.email ? `email:${command.email}` : null,
          command.phone ? `phone:${command.phone}` : null,
          command.messenger ? `messenger:${command.messenger}` : null,
        ]
          .filter((value): value is string => value !== null)
          .sort();
        for (const channelLock of channelLocks) {
          await transaction.$executeRaw(Prisma.sql`
            SELECT pg_advisory_xact_lock(hashtextextended(${channelLock}, 0))
          `);
        }
        await transaction.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`contact-links:${organizationId}`}, 0))
        `);

        const channelFilters: Prisma.ContactWhereInput[] = [
          ...(command.email ? [{ email: command.email }] : []),
          ...(command.phone ? [{ phone: command.phone }] : []),
          ...(command.messenger ? [{ messenger: command.messenger }] : []),
        ];
        const duplicateRecords = await transaction.contact.findMany({
          where: { mergedIntoId: null, archivedAt: null, OR: channelFilters },
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            messenger: true,
            organizationLinks: {
              where: { organizationId, validTo: null },
              select: { id: true },
              take: 1,
            },
          },
          take: 20,
        });
        const duplicates: ContactCandidate[] = duplicateRecords.map(
          ({ organizationLinks, ...candidate }) => ({
            ...candidate,
            isLinkedToOrganization: organizationLinks.length > 0,
          }),
        );
        if (duplicates.length > 0) throw new ContactDuplicateCandidatesError(duplicates);

        const activeLinks = await transaction.contactOrganization.count({
          where: { organizationId, validTo: null },
        });
        const contactId = randomUUID();
        const linkId = randomUUID();
        const isPrimary = activeLinks === 0;
        const result: ContactOption = {
          id: contactId,
          fullName: command.fullName,
          role: command.role,
          department: command.department ?? null,
          email: command.email ?? null,
          phone: command.phone ?? null,
          messenger: command.messenger ?? null,
          isPrimary,
        };

        await transaction.contact.create({
          data: {
            id: contactId,
            fullName: command.fullName,
            email: command.email,
            phone: command.phone,
            messenger: command.messenger,
            source: command.source ?? "web",
            verifiedAt: command.verifiedAt ? new Date(command.verifiedAt) : undefined,
            restrictions: toJson(command.restrictions ? { note: command.restrictions } : {}),
          },
        });
        await transaction.contactOrganization.create({
          data: {
            id: linkId,
            contactId,
            organizationId,
            role: command.role,
            department: command.department,
            isPrimary,
            validFrom: now,
          },
        });
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId: actor.id,
            action: "contact.create",
            entityType: "Contact",
            entityId: contactId,
            afterJson: toJson({ ...result, organizationId, restrictions: command.restrictions }),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: "contact.created",
            aggregateType: "Contact",
            aggregateId: contactId,
            aggregateVersion: 1,
            schemaVersion: 1,
            payload: toJson({ contactId, organizationId, actorId: actor.id }),
            occurredAt: now,
          },
        });
        const completed = await transaction.idempotencyRecord.updateMany({
          where: { id: reservationId, responseJson: { equals: Prisma.DbNull } },
          data: {
            responseStatus: 201,
            responseJson: toJson(result),
            completedAt: now,
          },
        });
        if (completed.count !== 1) {
          throw new Error("Contact idempotency reservation could not be completed");
        }
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async linkContact(
    organizationId: string,
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ContactOption> {
    const command = parseLinkContactCommand(input);
    const requestHash = linkContactRequestHash(command);
    const operation = `contact.link:${organizationId}:${contactId}`;
    const now = new Date();
    const reservationId = randomUUID();

    return this.prisma.$transaction(
      async (transaction) => {
        const actor = await this.actors.current(transaction);
        const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "idempotency_record" (
            "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
          ) VALUES (
            ${reservationId}::uuid,
            ${actor.id}::uuid,
            ${operation},
            ${idempotencyKey},
            ${requestHash},
            ${now},
            ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)}
          )
          ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
          RETURNING "id"
        `);

        if (inserted.length === 0) {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              actorId_operation_requestKey: {
                actorId: actor.id,
                operation,
                requestKey: idempotencyKey,
              },
            },
          });
          if (!existing) throw new IdempotencyInProgressError(idempotencyKey);
          if (existing.requestHash !== requestHash) {
            throw new IdempotencyConflictError(idempotencyKey);
          }
          const replay = parseContactOption(existing.responseJson);
          if (!replay) throw new IdempotencyInProgressError(idempotencyKey);
          return replay;
        }

        await transaction.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`contact-merge:${contactId}`}, 0))
        `);
        const [organization, contact] = await Promise.all([
          transaction.organization.findFirst({
            where: { id: organizationId, archivedAt: null, ...organizationScope(actor) },
            select: { id: true },
          }),
          transaction.contact.findFirst({
            where: { id: contactId, ...contactScope(actor) },
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              messenger: true,
              mergedIntoId: true,
              archivedAt: true,
            },
          }),
        ]);
        if (!organization) throw new OrganizationNotFoundError(organizationId);
        if (!contact) throw new ContactNotFoundError(contactId);
        if (contact.mergedIntoId) {
          throw new ContactAlreadyMergedError(contactId, contact.mergedIntoId);
        }
        if (contact.archivedAt) {
          throw new ContactStateError("Архивный контакт сначала нужно восстановить.");
        }

        await transaction.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`contact-links:${organizationId}`}, 0))
        `);
        const existingLink = await transaction.contactOrganization.findFirst({
          where: { organizationId, contactId, validTo: null },
          select: { id: true },
        });
        if (existingLink) throw new ContactAlreadyLinkedError(contactId, organizationId);

        const activeLinks = await transaction.contactOrganization.count({
          where: { organizationId, validTo: null },
        });
        const linkId = randomUUID();
        const result: ContactOption = {
          id: contact.id,
          fullName: contact.fullName,
          role: command.role,
          department: command.department ?? null,
          email: contact.email,
          phone: contact.phone,
          messenger: contact.messenger,
          isPrimary: activeLinks === 0,
        };

        await transaction.contactOrganization.create({
          data: {
            id: linkId,
            contactId,
            organizationId,
            role: command.role,
            department: command.department,
            isPrimary: result.isPrimary,
            validFrom: now,
          },
        });
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId: actor.id,
            action: "contact.link",
            entityType: "Contact",
            entityId: contactId,
            afterJson: toJson({
              contactId,
              organizationId,
              role: command.role,
              department: command.department,
            }),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: "contact.linked",
            aggregateType: "ContactOrganization",
            aggregateId: linkId,
            aggregateVersion: 1,
            schemaVersion: 1,
            payload: toJson({ contactId, organizationId, linkId, actorId: actor.id }),
            occurredAt: now,
          },
        });
        const completed = await transaction.idempotencyRecord.updateMany({
          where: { id: reservationId, responseJson: { equals: Prisma.DbNull } },
          data: {
            responseStatus: 201,
            responseJson: toJson(result),
            completedAt: now,
          },
        });
        if (completed.count !== 1) {
          throw new Error("Contact link idempotency reservation could not be completed");
        }
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async mergeContact(
    sourceContactId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<MergeContactResult> {
    const command = parseMergeContactCommand(input);
    const requestHash = mergeContactRequestHash(command);
    const operation = `contact.merge:${sourceContactId}`;
    const now = new Date();
    const reservationId = randomUUID();

    return this.prisma.$transaction(
      async (transaction) => {
        const actor = await this.actors.current(transaction);
        const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "idempotency_record" (
            "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
          ) VALUES (
            ${reservationId}::uuid,
            ${actor.id}::uuid,
            ${operation},
            ${idempotencyKey},
            ${requestHash},
            ${now},
            ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)}
          )
          ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
          RETURNING "id"
        `);

        if (inserted.length === 0) {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              actorId_operation_requestKey: {
                actorId: actor.id,
                operation,
                requestKey: idempotencyKey,
              },
            },
          });
          if (!existing) throw new IdempotencyInProgressError(idempotencyKey);
          if (existing.requestHash !== requestHash) {
            throw new IdempotencyConflictError(idempotencyKey);
          }
          const replay = parseMergeContactResult(existing.responseJson);
          if (!replay) throw new IdempotencyInProgressError(idempotencyKey);
          return replay;
        }

        if (sourceContactId === command.targetContactId) {
          throw new ContactMergeSameContactError(sourceContactId);
        }
        await transaction.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended('contact-merge-graph', 0))
        `);
        for (const contactId of [sourceContactId, command.targetContactId].sort()) {
          await transaction.$executeRaw(Prisma.sql`
            SELECT pg_advisory_xact_lock(hashtextextended(${`contact-merge:${contactId}`}, 0))
          `);
        }

        const [source, target] = await Promise.all([
          transaction.contact.findFirst({
            where: { id: sourceContactId, ...contactScope(actor) },
            select: { id: true, mergedIntoId: true, archivedAt: true },
          }),
          transaction.contact.findFirst({
            where: { id: command.targetContactId, ...contactScope(actor) },
            select: { id: true, mergedIntoId: true, archivedAt: true },
          }),
        ]);
        if (!source) throw new ContactNotFoundError(sourceContactId);
        if (!target) throw new ContactNotFoundError(command.targetContactId);
        if (source.mergedIntoId) {
          throw new ContactAlreadyMergedError(sourceContactId, source.mergedIntoId);
        }
        if (target.mergedIntoId) {
          throw new ContactMergeTargetRetiredError(target.id, target.mergedIntoId);
        }
        if (source.archivedAt || target.archivedAt) {
          throw new ContactStateError("Архивный контакт сначала нужно восстановить.");
        }

        const previouslyMergedContacts = await transaction.contact.findMany({
          where: { mergedIntoId: sourceContactId },
          select: { id: true },
        });
        for (const { id } of previouslyMergedContacts.sort((left, right) =>
          left.id.localeCompare(right.id),
        )) {
          await transaction.$executeRaw(Prisma.sql`
            SELECT pg_advisory_xact_lock(hashtextextended(${`contact-merge:${id}`}, 0))
          `);
        }

        const sourceLinks = await transaction.contactOrganization.findMany({
          where: { contactId: sourceContactId, validTo: null },
          select: { id: true, organizationId: true },
        });
        const organizationIds = [
          ...new Set(sourceLinks.map(({ organizationId }) => organizationId)),
        ].sort();
        for (const organizationId of organizationIds) {
          await transaction.$executeRaw(Prisma.sql`
            SELECT pg_advisory_xact_lock(hashtextextended(${`contact-links:${organizationId}`}, 0))
          `);
        }

        const targetLinks =
          organizationIds.length === 0
            ? []
            : await transaction.contactOrganization.findMany({
                where: {
                  contactId: target.id,
                  organizationId: { in: organizationIds },
                  validTo: null,
                },
                select: { organizationId: true },
              });
        const conflictingOrganizations = new Set(
          targetLinks.map(({ organizationId }) => organizationId),
        );
        const conflictingLinkIds = sourceLinks
          .filter(({ organizationId }) => conflictingOrganizations.has(organizationId))
          .map(({ id }) => id);
        const movableLinkIds = sourceLinks
          .filter(({ organizationId }) => !conflictingOrganizations.has(organizationId))
          .map(({ id }) => id);

        if (conflictingLinkIds.length > 0) {
          await transaction.contactOrganization.updateMany({
            where: { id: { in: conflictingLinkIds }, contactId: sourceContactId, validTo: null },
            data: { validTo: now, isPrimary: false },
          });
        }
        if (movableLinkIds.length > 0) {
          await transaction.contactOrganization.updateMany({
            where: { id: { in: movableLinkIds }, contactId: sourceContactId, validTo: null },
            data: { contactId: target.id },
          });
        }
        const movedInteractions = await transaction.interaction.updateMany({
          where: { contactId: sourceContactId },
          data: { contactId: target.id },
        });
        await transaction.contact.update({
          where: { id: sourceContactId },
          data: {
            mergedIntoId: target.id,
            mergedAt: now,
            mergeReason: command.reason,
          },
        });
        if (previouslyMergedContacts.length > 0) {
          await transaction.contact.updateMany({
            where: { mergedIntoId: sourceContactId },
            data: { mergedIntoId: target.id },
          });
        }

        const outboxEventId = randomUUID();
        const result: MergeContactResult = {
          sourceContactId,
          targetContactId: target.id,
          movedOrganizationLinks: movableLinkIds.length,
          closedConflictingLinks: conflictingLinkIds.length,
          movedInteractions: movedInteractions.count,
          outboxEventId,
        };
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId: actor.id,
            action: "contact.merge",
            entityType: "Contact",
            entityId: sourceContactId,
            beforeJson: toJson({ mergedIntoId: null }),
            afterJson: toJson({
              ...result,
              reason: command.reason,
              mergedAt: now.toISOString(),
              repointedMergedContacts: previouslyMergedContacts.length,
            }),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: outboxEventId,
            eventType: "contact.merged",
            aggregateType: "Contact",
            aggregateId: sourceContactId,
            aggregateVersion: 1,
            schemaVersion: 1,
            payload: toJson({ ...result, reason: command.reason, actorId: actor.id }),
            occurredAt: now,
          },
        });
        const completed = await transaction.idempotencyRecord.updateMany({
          where: { id: reservationId, responseJson: { equals: Prisma.DbNull } },
          data: {
            responseStatus: 200,
            responseJson: toJson(result),
            completedAt: now,
          },
        });
        if (completed.count !== 1) {
          throw new Error("Contact merge idempotency reservation could not be completed");
        }
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async updateContact(
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ContactRegistryItem> {
    const command = parseUpdateContactCommand(input);
    return this.runContactMutation(
      `contact.update:${contactId}`,
      idempotencyKey,
      updateContactRequestHash(command),
      async (transaction, now, actor) => {
        await lockContact(transaction, contactId);
        const current = await transaction.contact.findFirst({
          where: { id: contactId, ...contactScope(actor) },
          include: contactRegistryInclude,
        });
        assertEditableContact(current, contactId, command.version);

        const channelFilters: Prisma.ContactWhereInput[] = [
          ...(command.email ? [{ email: command.email }] : []),
          ...(command.phone ? [{ phone: command.phone }] : []),
          ...(command.messenger ? [{ messenger: command.messenger }] : []),
        ];
        const duplicates = await transaction.contact.findMany({
          where: {
            id: { not: contactId },
            archivedAt: null,
            mergedIntoId: null,
            OR: channelFilters,
          },
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            messenger: true,
          },
          take: 20,
        });
        if (duplicates.length > 0) {
          throw new ContactDuplicateCandidatesError(
            duplicates.map((candidate) => ({
              ...candidate,
              isLinkedToOrganization: false,
            })),
          );
        }

        if (command.organizationLink) {
          const changedLink = await transaction.contactOrganization.updateMany({
            where: {
              id: command.organizationLink.id,
              contactId,
              validTo: null,
            },
            data: {
              role: command.organizationLink.role,
              department: command.organizationLink.department ?? null,
            },
          });
          if (changedLink.count !== 1) {
            throw new ContactStateError("Связь контакта с организацией не найдена.");
          }
        }

        const updated = await transaction.contact.updateMany({
          where: { id: contactId, version: command.version, archivedAt: null, mergedIntoId: null },
          data: {
            fullName: command.fullName,
            email: command.email ?? null,
            phone: command.phone ?? null,
            messenger: command.messenger ?? null,
            source: command.source,
            verifiedAt: command.verifiedAt ? new Date(command.verifiedAt) : null,
            restrictions: toJson(command.restrictions ? { note: command.restrictions } : {}),
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          const latest = await transaction.contact.findUnique({
            where: { id: contactId },
            select: { version: true },
          });
          throw new ContactVersionConflictError(contactId, latest?.version ?? command.version);
        }
        const resultRecord = await transaction.contact.findUnique({
          where: { id: contactId },
          include: contactRegistryInclude,
        });
        if (!resultRecord) throw new ContactNotFoundError(contactId);
        const result = toContactRegistryItem(resultRecord, []);
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId: actor.id,
            action: "contact.update",
            entityType: "Contact",
            entityId: contactId,
            beforeJson: toJson(toContactRegistryItem(current as ContactRegistryRecord, [])),
            afterJson: toJson(result),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: "contact.updated",
            aggregateType: "Contact",
            aggregateId: contactId,
            aggregateVersion: result.version,
            schemaVersion: 1,
            payload: toJson({ contactId, version: result.version, actorId: actor.id }),
            occurredAt: now,
          },
        });
        return result;
      },
    );
  }

  async archiveContact(
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ContactRegistryItem> {
    return this.changeContactArchived(contactId, input, idempotencyKey, true);
  }

  async restoreContact(
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ContactRegistryItem> {
    return this.changeContactArchived(contactId, input, idempotencyKey, false);
  }

  private async changeContactArchived(
    contactId: string,
    input: unknown,
    idempotencyKey: string,
    archived: boolean,
  ) {
    const command = parseChangeContactStatusCommand(input);
    return this.runContactMutation(
      `contact.${archived ? "archive" : "restore"}:${contactId}`,
      idempotencyKey,
      contactStatusRequestHash(command),
      async (transaction, now, actor) => {
        await lockContact(transaction, contactId);
        const current = await transaction.contact.findFirst({
          where: { id: contactId, ...contactScope(actor) },
          include: contactRegistryInclude,
        });
        if (!current) throw new ContactNotFoundError(contactId);
        if (current.mergedIntoId) {
          throw new ContactStateError(
            "Объединённый контакт нельзя архивировать или восстанавливать.",
          );
        }
        if (current.version !== command.version) {
          throw new ContactVersionConflictError(contactId, current.version);
        }
        if (Boolean(current.archivedAt) === archived) {
          throw new ContactStateError(
            archived ? "Контакт уже архивирован." : "Контакт уже активен.",
          );
        }
        const changed = await transaction.contact.updateMany({
          where: {
            id: contactId,
            version: command.version,
            archivedAt: archived ? null : { not: null },
            mergedIntoId: null,
          },
          data: {
            archivedAt: archived ? now : null,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          const latest = await transaction.contact.findUnique({
            where: { id: contactId },
            select: { version: true },
          });
          throw new ContactVersionConflictError(contactId, latest?.version ?? command.version);
        }
        const resultRecord = await transaction.contact.findUnique({
          where: { id: contactId },
          include: contactRegistryInclude,
        });
        if (!resultRecord) throw new ContactNotFoundError(contactId);
        const result = toContactRegistryItem(resultRecord, []);
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId: actor.id,
            action: archived ? "contact.archive" : "contact.restore",
            entityType: "Contact",
            entityId: contactId,
            beforeJson: toJson({
              version: current.version,
              archivedAt: current.archivedAt,
              reason: command.reason,
            }),
            afterJson: toJson({
              version: result.version,
              archivedAt: result.archivedAt,
              reason: command.reason,
            }),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: archived ? "contact.archived" : "contact.restored",
            aggregateType: "Contact",
            aggregateId: contactId,
            aggregateVersion: result.version,
            schemaVersion: 1,
            payload: toJson({
              contactId,
              version: result.version,
              reason: command.reason,
              actorId: actor.id,
            }),
            occurredAt: now,
          },
        });
        return result;
      },
    );
  }

  private async runContactMutation(
    operation: string,
    idempotencyKey: string,
    requestHash: string,
    mutate: (
      transaction: Prisma.TransactionClient,
      now: Date,
      actor: PersistenceActor,
    ) => Promise<ContactRegistryItem>,
  ): Promise<ContactRegistryItem> {
    const now = new Date();
    const reservationId = randomUUID();
    return this.prisma.$transaction(
      async (transaction) => {
        const actor = await this.actors.current(transaction);
        const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "idempotency_record" (
          "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
        ) VALUES (
          ${reservationId}::uuid,
          ${actor.id}::uuid,
          ${operation},
          ${idempotencyKey},
          ${requestHash},
          ${now},
          ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)}
        )
        ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
        RETURNING "id"
      `);
        if (inserted.length === 0) {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              actorId_operation_requestKey: {
                actorId: actor.id,
                operation,
                requestKey: idempotencyKey,
              },
            },
          });
          if (!existing) throw new IdempotencyInProgressError(idempotencyKey);
          if (existing.requestHash !== requestHash)
            throw new IdempotencyConflictError(idempotencyKey);
          const replay = parseContactRegistryItem(existing.responseJson);
          if (!replay) throw new IdempotencyInProgressError(idempotencyKey);
          return replay;
        }
        const result = await mutate(transaction, now, actor);
        const completed = await transaction.idempotencyRecord.updateMany({
          where: { id: reservationId, responseJson: { equals: Prisma.DbNull } },
          data: {
            responseStatus: 200,
            responseJson: toJson(result),
            completedAt: now,
          },
        });
        if (completed.count !== 1)
          throw new Error("Contact mutation reservation could not be completed");
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}

function contactRegistryWhere(
  query: {
    search?: string;
    status?: string;
    organizationId?: string;
  },
  actor: PersistenceActor,
): Prisma.ContactWhereInput {
  const status: Prisma.ContactWhereInput =
    query.status === "archived"
      ? { archivedAt: { not: null }, mergedIntoId: null }
      : query.status === "merged"
        ? { mergedIntoId: { not: null } }
        : query.status === "all"
          ? {}
          : { archivedAt: null, mergedIntoId: null };
  const search = query.search?.trim();
  return {
    AND: [
      contactScope(actor),
      status,
      ...(query.organizationId
        ? [
            {
              organizationLinks: { some: { organizationId: query.organizationId, validTo: null } },
            } satisfies Prisma.ContactWhereInput,
          ]
        : []),
      ...(search
        ? [
            {
              OR: [
                { fullName: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
                { phone: { contains: search } },
                { messenger: { contains: search, mode: "insensitive" } },
                {
                  organizationLinks: {
                    some: {
                      validTo: null,
                      organization: { name: { contains: search, mode: "insensitive" } },
                    },
                  },
                },
              ],
            } satisfies Prisma.ContactWhereInput,
          ]
        : []),
    ],
  };
}

function toContactRegistryItem(
  record: ContactRegistryRecord,
  duplicatePool: Array<{
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    messenger: string | null;
  }>,
  visibleOrganizationIds?: ReadonlySet<string>,
): ContactRegistryItem {
  return {
    id: record.id,
    version: record.version,
    fullName: record.fullName,
    email: record.email,
    phone: record.phone,
    messenger: record.messenger,
    source: record.source,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    restrictions: restrictionNote(record.restrictions),
    status: record.mergedIntoId ? "merged" : record.archivedAt ? "archived" : "active",
    archivedAt: record.archivedAt?.toISOString() ?? null,
    mergedIntoId: record.mergedIntoId,
    updatedAt: record.updatedAt.toISOString(),
    organizationLinks: record.organizationLinks
      .filter((link) => !visibleOrganizationIds || visibleOrganizationIds.has(link.organizationId))
      .map((link) => ({
        id: link.id,
        organizationId: link.organizationId,
        organizationName: link.organization.name,
        role: link.role,
        department: link.department,
        isPrimary: link.isPrimary,
        validFrom: link.validFrom.toISOString(),
        validTo: link.validTo?.toISOString() ?? null,
      })),
    duplicateMatches:
      record.archivedAt || record.mergedIntoId
        ? []
        : duplicatePool
            .filter((candidate) => candidate.id !== record.id)
            .map((candidate) => ({
              contactId: candidate.id,
              fullName: candidate.fullName,
              matchedOn: [
                record.email && record.email === candidate.email ? "email" : null,
                record.phone && record.phone === candidate.phone ? "phone" : null,
                record.messenger && record.messenger === candidate.messenger ? "messenger" : null,
              ].filter(Boolean) as Array<"email" | "phone" | "messenger">,
            }))
            .filter(({ matchedOn }) => matchedOn.length > 0),
  };
}

function restrictionNote(value: Prisma.JsonValue): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return typeof value.note === "string" && value.note.trim() ? value.note : null;
}

function assertEditableContact(
  contact: ContactRegistryRecord | null,
  contactId: string,
  version: number,
): asserts contact is ContactRegistryRecord {
  if (!contact) throw new ContactNotFoundError(contactId);
  if (contact.mergedIntoId) throw new ContactStateError("Контакт уже объединён.");
  if (contact.archivedAt)
    throw new ContactStateError("Архивный контакт сначала нужно восстановить.");
  if (contact.version !== version)
    throw new ContactVersionConflictError(contactId, contact.version);
}

async function lockContact(transaction: Prisma.TransactionClient, contactId: string) {
  await transaction.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`contact-registry:${contactId}`}, 0))
  `);
}

function parseContactRegistryItem(value: Prisma.JsonValue | null): ContactRegistryItem | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    typeof value.version !== "number" ||
    typeof value.fullName !== "string" ||
    !Array.isArray(value.organizationLinks) ||
    !Array.isArray(value.duplicateMatches)
  )
    return null;
  return value as unknown as ContactRegistryItem;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseContactOption(value: Prisma.JsonValue | null): ContactOption | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    typeof value.fullName !== "string" ||
    typeof value.role !== "string" ||
    !(typeof value.department === "string" || value.department === null) ||
    !(typeof value.email === "string" || value.email === null) ||
    !(typeof value.phone === "string" || value.phone === null) ||
    !(typeof value.messenger === "string" || value.messenger === null) ||
    typeof value.isPrimary !== "boolean"
  ) {
    return null;
  }
  return {
    id: value.id,
    fullName: value.fullName,
    role: value.role,
    department: value.department,
    email: value.email,
    phone: value.phone,
    messenger: value.messenger,
    isPrimary: value.isPrimary,
  };
}

function parseMergeContactResult(value: Prisma.JsonValue | null): MergeContactResult | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.sourceContactId !== "string" ||
    typeof value.targetContactId !== "string" ||
    typeof value.movedOrganizationLinks !== "number" ||
    typeof value.closedConflictingLinks !== "number" ||
    typeof value.movedInteractions !== "number" ||
    typeof value.outboxEventId !== "string"
  ) {
    return null;
  }
  return {
    sourceContactId: value.sourceContactId,
    targetContactId: value.targetContactId,
    movedOrganizationLinks: value.movedOrganizationLinks,
    closedConflictingLinks: value.closedConflictingLinks,
    movedInteractions: value.movedInteractions,
    outboxEventId: value.outboxEventId,
  };
}
