import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, TaskStatus } from "@prisma/client";
import {
  radarRejectReasonCodes,
  type RadarCandidate,
  type RadarCandidateDecisionCommand,
  type RadarCandidateFeatures,
  type RadarCandidateStatus,
  type RadarConfidence,
  type RadarDecision,
  type RadarDetectedPlayer,
  type RadarEvidenceStatus,
  type RadarImportResult,
  type RadarPayload,
  type RadarPriority,
  type RadarRejectReasonCode,
  type RadarResearch,
  type RadarScore,
  type RadarScoreFactor,
} from "@embed-os/contracts";
import {
  calculatePartnerScore,
  calculatePriority,
  DomainRuleError,
  emptyRadarFeatures,
  normalizeRadarTarget,
  parseCreateRadarCandidateCommand,
  parseRadarDecisionCommand,
  parseRadarScoreAdjustmentCommand,
} from "@embed-os/domain";
import { IdempotencyInProgressError } from "../application/idempotency.js";
import { completeIdempotency, reserveOrReplay } from "./idempotency-gateway.js";
import {
  RADAR_INSPECTOR,
  type RadarInspectionObservation,
  type RadarInspector,
} from "../monitoring/radar-page-inspector.js";
import {
  enrichRadarResearchWithChanges,
  mergeRadarFeatures,
} from "../monitoring/radar-feature-extractor.js";
import {
  RADAR_TRAFFIC_STATUS,
  type RadarTrafficStatus,
} from "../monitoring/radar-traffic-provider.js";
import { parseRadarImportFile } from "../application/radar-import.js";
import type { OrganizationImportFile } from "../application/organization-import.js";
import type { RadarPort } from "../radar.port.js";
import {
  RadarCandidateNotFoundError,
  RadarCandidateStateError,
  RadarCandidateVersionConflictError,
} from "../radar.service.js";
import {
  organizationScope,
  PersistenceActorService,
  radarCandidateScope,
  requireActorTeam,
  type PersistenceActor,
} from "./persistence-actor.service.js";
import { PrismaService } from "./prisma.service.js";

const radarInclude = Prisma.validator<Prisma.RadarCandidateInclude>()({
  duplicateOrganization: { select: { id: true, name: true } },
  duplicateCandidate: { select: { id: true, name: true } },
  evidence: { orderBy: [{ detectedAt: "asc" }, { id: "asc" }] },
  scoreSnapshots: { orderBy: [{ calculatedAt: "desc" }, { id: "desc" }], take: 1 },
  decisions: {
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
    include: { actor: { select: { id: true, displayName: true } } },
  },
});

type DbRadarCandidate = Prisma.RadarCandidateGetPayload<{ include: typeof radarInclude }>;

@Injectable()
export class PostgresRadarService implements RadarPort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RADAR_INSPECTOR) private readonly inspector: RadarInspector,
    @Inject(PersistenceActorService) private readonly actors: PersistenceActorService,
    @Optional()
    @Inject(RADAR_TRAFFIC_STATUS)
    private readonly trafficStatus?: RadarTrafficStatus,
  ) {}

  async list(): Promise<RadarPayload> {
    const actor = await this.actors.current();
    const records = await this.prisma.radarCandidate.findMany({
      where: radarCandidateScope(actor),
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      include: radarInclude,
    });
    return {
      generatedAt: new Date().toISOString(),
      total: records.length,
      trafficProvider: this.trafficStatus ?? { configured: false, provider: null },
      candidates: records.map(mapCandidate),
    };
  }

  async create(input: unknown, idempotencyKey: string): Promise<RadarCandidate> {
    const command = parseCreateRadarCandidateCommand(input);
    const normalized = normalizeRadarTarget(command.url);
    const requestHash = hash(command);
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(
      async (transaction) => {
        const actor = await this.actors.current(transaction);
        const teamId = requireActorTeam(actor);
        const replay = await reserveOrReplay(transaction, {
          recordId: reservationId,
          actorId: actor.id,
          operation: "radar.create",
          requestKey: idempotencyKey,
          requestHash,
          now,
        });
        if (replay) return parseReplay(replay, idempotencyKey);
        await lockHost(transaction, teamId, normalized.hostNormalized);
        const [duplicateOrganization, duplicateCandidate] = await Promise.all([
          transaction.organization.findFirst({
            where: {
              archivedAt: null,
              ...organizationScope(actor),
              domains: { some: { hostNormalized: normalized.hostNormalized, archivedAt: null } },
            },
            select: { id: true, name: true },
          }),
          transaction.radarCandidate.findFirst({
            where: {
              ...radarCandidateScope(actor),
              hostNormalized: normalized.hostNormalized,
              status: { notIn: ["REJECTED", "MERGED"] },
            },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          }),
        ]);
        const features = emptyRadarFeatures(command);
        const score = calculatePartnerScore({
          features,
          latestEvidence: null,
          duplicateOrganization: duplicateOrganization !== null,
          duplicateCandidate: duplicateCandidate !== null,
          calculatedAt: now,
        });
        const created = await transaction.radarCandidate.create({
          data: {
            id: randomUUID(),
            teamId,
            createdById: actor.id,
            name: command.name,
            source: command.source,
            inputUrl: command.url,
            pageUrl: normalized.pageUrl,
            hostNormalized: normalized.hostNormalized,
            status: "NEW",
            featuresJson: serializeFeatures(features, null),
            ...scoreColumns(score),
            duplicateOrganizationId: duplicateOrganization?.id ?? null,
            duplicateCandidateId: duplicateCandidate?.id ?? null,
            scoreSnapshots: { create: scoreSnapshotData(score) },
          },
          include: radarInclude,
        });
        const response = mapCandidate(created);
        await recordMutation(transaction, actor.id, response, "radar.candidate-created", now);
        await completeIdempotency(transaction, {
          recordId: reservationId,
          responseStatus: 201,
          responseJson: toJson(response),
          completedAt: now,
        });
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async import(file: OrganizationImportFile, idempotencyKey: string): Promise<RadarImportResult> {
    const parsed = await parseRadarImportFile(file);
    const rows: RadarImportResult["rows"] = [];
    const seen = new Set<string>();
    for (const row of parsed.rows) {
      try {
        const normalized = normalizeRadarTarget(row.command.url);
        if (seen.has(normalized.hostNormalized)) {
          rows.push({
            rowNo: row.rowNo,
            status: "skipped",
            candidateId: null,
            hostNormalized: normalized.hostNormalized,
            message: "Домен уже встречался в этом файле",
          });
          continue;
        }
        seen.add(normalized.hostNormalized);
        const created = await this.create(row.command, `${idempotencyKey}:${row.rowNo}`);
        const skipped = Boolean(created.duplicateOrganization || created.duplicateCandidate);
        rows.push({
          rowNo: row.rowNo,
          status: skipped ? "skipped" : "created",
          candidateId: created.id,
          hostNormalized: created.hostNormalized,
          message: created.duplicateOrganization
            ? `Домен уже у партнёра «${created.duplicateOrganization.name}»`
            : created.duplicateCandidate
              ? `Дубль кандидата «${created.duplicateCandidate.name}»`
              : "Кандидат добавлен",
        });
      } catch (error) {
        rows.push({
          rowNo: row.rowNo,
          status: "failed",
          candidateId: null,
          hostNormalized: null,
          message: error instanceof Error ? error.message : "Ошибка строки",
        });
      }
    }
    return {
      fileName: parsed.fileName,
      format: parsed.format,
      total: rows.length,
      created: rows.filter(({ status }) => status === "created").length,
      skipped: rows.filter(({ status }) => status === "skipped").length,
      failed: rows.filter(({ status }) => status === "failed").length,
      warnings: parsed.warnings,
      rows,
    };
  }

  async requestInspection(candidateId: string, idempotencyKey: string): Promise<RadarCandidate> {
    const requestHash = hash({ candidateId });
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(
      async (transaction) => {
        const actor = await this.actors.current(transaction);
        const replay = await reserveOrReplay(transaction, {
          recordId: reservationId,
          actorId: actor.id,
          operation: `radar.request-inspection:${candidateId}`,
          requestKey: idempotencyKey,
          requestHash,
          now,
        });
        if (replay) return parseReplay(replay, idempotencyKey);
        await lockCandidate(transaction, candidateId);
        const current = await findCandidate(transaction, candidateId, actor);
        assertMutable(current);
        const updated = await transaction.radarCandidate.update({
          where: { id: candidateId },
          data: { inspectionRequestedAt: now, version: { increment: 1 } },
          include: radarInclude,
        });
        const response = mapCandidate(updated);
        await recordMutation(transaction, actor.id, response, "radar.inspection-requested", now);
        await completeIdempotency(transaction, {
          recordId: reservationId,
          responseStatus: 202,
          responseJson: toJson(response),
          completedAt: now,
        });
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Executes requested inspections, oldest request first. The radar recheck
   * worker calls this ahead of scheduled rechecks, so a user-triggered check
   * always has priority over the periodic batch.
   */
  async processRequestedInspections(limit = 25): Promise<{ processed: number; failed: number }> {
    const requested = await this.prisma.radarCandidate.findMany({
      where: {
        inspectionRequestedAt: { not: null },
        status: { notIn: ["ACCEPTED", "REJECTED", "MERGED"] },
      },
      orderBy: [{ inspectionRequestedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, inspectionRequestedAt: true },
    });
    let processed = 0;
    let failed = 0;
    for (const candidate of requested) {
      // The key is derived from the request timestamp, so a worker restart
      // replays the same inspection instead of duplicating evidence.
      const key = `radar-requested:${candidate.id}:${candidate.inspectionRequestedAt!.getTime()}`;
      try {
        await this.inspect(candidate.id, key);
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    return { processed, failed };
  }

  async inspect(candidateId: string, idempotencyKey: string): Promise<RadarCandidate> {
    // Inspections run both from HTTP requests and from the radar recheck
    // worker, which has no session.
    const actor = await this.actors.currentOrSystem();
    const visible = await this.prisma.radarCandidate.findFirst({
      where: { id: candidateId, ...radarCandidateScope(actor) },
      select: { pageUrl: true },
    });
    if (!visible) throw new RadarCandidateNotFoundError(candidateId);
    const requestHash = hash({ candidateId });
    const reservationId = randomUUID();
    const now = new Date();

    // A short transaction reserves the idempotency key BEFORE the external
    // HTTP inspection, so a concurrent replay never repeats the network call.
    const replay = await this.prisma.$transaction((transaction) =>
      reserveOrReplay(transaction, {
        recordId: reservationId,
        actorId: actor.id,
        operation: `radar.inspect:${candidateId}`,
        requestKey: idempotencyKey,
        requestHash,
        now,
      }),
    );
    if (replay) return parseReplay(replay, idempotencyKey);

    let observation: RadarInspectionObservation;
    try {
      observation = await this.inspector.inspect(visible.pageUrl);
    } catch (error) {
      await this.releaseReservation(reservationId);
      throw error;
    }

    const result = this.prisma.$transaction(
      async (transaction) => {
        await lockCandidate(transaction, candidateId);
        const current = await findCandidate(transaction, candidateId, actor);
        assertMutable(current);
        const detectedPlayers = observation.detectedPlayers ?? [];
        const evidence = {
          id: randomUUID(),
          pageUrl: observation.pageUrl,
          status: observation.status,
          playerType: observation.playerType,
          detectedAt: observation.detectedAt.toISOString(),
          method: observation.method,
          confidence: observation.confidence,
          httpStatus: observation.httpStatus,
          playerFound: observation.playerFound,
          embedUrl: observation.embedUrl,
          errorCode: observation.errorCode,
          detectedPlayers,
          competitorPlayerDetected:
            observation.competitorPlayerDetected ??
            detectedPlayers.some(({ competitor }) => competitor),
        } as const;
        const currentFeatures = parseFeatures(current.featuresJson);
        const features = observation.featureExtraction
          ? mergeRadarFeatures(currentFeatures, observation.featureExtraction.features)
          : currentFeatures;
        const previousResearch = parseResearch(current.featuresJson);
        const research = observation.featureExtraction
          ? enrichRadarResearchWithChanges(previousResearch, observation.featureExtraction.research)
          : previousResearch;
        const score = calculatePartnerScore({
          features,
          latestEvidence: evidence,
          duplicateOrganization: current.duplicateOrganizationId !== null,
          duplicateCandidate: current.duplicateCandidateId !== null,
          manualAdjustment: current.scoreManualAdjustment,
          manualAdjustmentComment: current.scoreManualComment,
          calculatedAt: now,
        });
        const updated = await transaction.radarCandidate.update({
          where: { id: candidateId },
          data: {
            pageUrl: observation.pageUrl,
            status: "READY",
            inspectionRequestedAt: null,
            featuresJson: serializeFeatures(features, research),
            version: { increment: 1 },
            ...scoreColumns(score),
            evidence: {
              create: {
                id: evidence.id,
                pageUrl: evidence.pageUrl,
                status: evidence.status.toUpperCase(),
                playerType: evidence.playerType,
                detectedAt: observation.detectedAt,
                method: evidence.method,
                confidence: evidence.confidence.toUpperCase(),
                httpStatus: evidence.httpStatus,
                playerFound: evidence.playerFound,
                embedUrl: evidence.embedUrl,
                errorCode: evidence.errorCode,
                detectedPlayersJson: toJson(evidence.detectedPlayers),
              },
            },
            scoreSnapshots: { create: scoreSnapshotData(score) },
          },
          include: radarInclude,
        });
        const response = mapCandidate(updated);
        await recordMutation(transaction, actor.id, response, "radar.candidate-inspected", now);
        await completeIdempotency(transaction, {
          recordId: reservationId,
          responseStatus: 200,
          responseJson: toJson(response),
          completedAt: now,
        });
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    try {
      return await result;
    } catch (error) {
      await this.releaseReservation(reservationId);
      throw error;
    }
  }

  /**
   * Best-effort removal of an unfinished idempotency reservation so a failed
   * inspection can be retried with the same key.
   */
  private async releaseReservation(reservationId: string): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.deleteMany({
        where: { id: reservationId, responseJson: { equals: Prisma.DbNull } },
      });
    } catch {
      // The reservation expires on its own; failing to clean it up must not
      // mask the original error.
    }
  }

  async decide(
    candidateId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<RadarCandidate> {
    const command = parseRadarDecisionCommand(input);
    const requestHash = hash(command);
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(
      async (transaction) => {
        const actor = await this.actors.current(transaction);
        const replay = await reserveOrReplay(transaction, {
          recordId: reservationId,
          actorId: actor.id,
          operation: `radar.decide:${candidateId}`,
          requestKey: idempotencyKey,
          requestHash,
          now,
        });
        if (replay) return parseReplay(replay, idempotencyKey);
        await lockCandidate(transaction, candidateId);
        const current = await findCandidate(transaction, candidateId, actor);
        assertMutable(current);
        assertVersion(current.version, command.version);
        const relationIds = await applyDecisionSideEffects(
          transaction,
          current,
          command,
          actor,
          now,
        );
        const status = decisionStatus(command.decision);
        const updated = await transaction.radarCandidate.update({
          where: { id: candidateId },
          data: {
            status,
            inspectionRequestedAt: status === "DEFERRED" ? current.inspectionRequestedAt : null,
            deferUntil:
              command.decision === "defer" && command.deferUntil
                ? new Date(command.deferUntil)
                : current.deferUntil,
            rejectionReason:
              command.decision === "reject" ? command.reason : current.rejectionReason,
            rejectionComment:
              command.decision === "reject" ? (command.comment ?? null) : current.rejectionComment,
            mergedIntoCandidateId: command.decision === "merge" ? command.mergeTargetId : null,
            acceptedOrganizationId: relationIds.organizationId,
            acceptedOpportunityId: relationIds.opportunityId,
            version: { increment: 1 },
            decisions: {
              create: {
                id: randomUUID(),
                actorId: actor.id,
                decision: command.decision.toUpperCase(),
                reason: command.reason,
                reasonCode: command.reasonCode ?? null,
                comment: command.comment ?? null,
                deferUntil: command.deferUntil ? new Date(command.deferUntil) : null,
                mergeTargetId: command.mergeTargetId ?? null,
                // Score feedback loop: fix the score and formula version the
                // manager saw at decision time — the calibration report reads
                // these columns instead of guessing from snapshots.
                scoreAtDecision: current.scoreTotal,
                formulaVersion: current.scoreModelVersion,
                decidedAt: now,
              },
            },
          },
          include: radarInclude,
        });
        const response = mapCandidate(updated);
        await recordMutation(
          transaction,
          actor.id,
          response,
          `radar.candidate-${command.decision}`,
          now,
        );
        await completeIdempotency(transaction, {
          recordId: reservationId,
          responseStatus: 200,
          responseJson: toJson(response),
          completedAt: now,
        });
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async adjustScore(
    candidateId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<RadarCandidate> {
    const command = parseRadarScoreAdjustmentCommand(input);
    const requestHash = hash(command);
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(
      async (transaction) => {
        const actor = await this.actors.current(transaction);
        const replay = await reserveOrReplay(transaction, {
          recordId: reservationId,
          actorId: actor.id,
          operation: `radar.score:${candidateId}`,
          requestKey: idempotencyKey,
          requestHash,
          now,
        });
        if (replay) return parseReplay(replay, idempotencyKey);
        await lockCandidate(transaction, candidateId);
        const current = await findCandidate(transaction, candidateId, actor);
        assertMutable(current);
        assertVersion(current.version, command.version);
        const latestEvidence = current.evidence.at(-1);
        const score = calculatePartnerScore({
          features: parseFeatures(current.featuresJson),
          latestEvidence: latestEvidence ? mapEvidence(latestEvidence) : null,
          duplicateOrganization: current.duplicateOrganizationId !== null,
          duplicateCandidate: current.duplicateCandidateId !== null,
          manualAdjustment: command.adjustment,
          manualAdjustmentComment: command.comment,
          calculatedAt: now,
        });
        const updated = await transaction.radarCandidate.update({
          where: { id: candidateId },
          data: {
            version: { increment: 1 },
            ...scoreColumns(score),
            scoreSnapshots: { create: scoreSnapshotData(score) },
          },
          include: radarInclude,
        });
        const response = mapCandidate(updated);
        await recordMutation(transaction, actor.id, response, "radar.score-adjusted", now);
        await completeIdempotency(transaction, {
          recordId: reservationId,
          responseStatus: 200,
          responseJson: toJson(response),
          completedAt: now,
        });
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

async function applyDecisionSideEffects(
  transaction: Prisma.TransactionClient,
  candidate: DbRadarCandidate,
  command: RadarCandidateDecisionCommand,
  actor: PersistenceActor,
  now: Date,
) {
  if (command.decision === "merge") {
    if (command.mergeTargetId === candidate.id) {
      throw new DomainRuleError("RAD-007", "Кандидата нельзя объединить с самим собой", {
        mergeTargetId: "Выберите другого кандидата",
      });
    }
    const target = await transaction.radarCandidate.findFirst({
      where: {
        id: command.mergeTargetId,
        ...radarCandidateScope(actor),
        status: { not: "MERGED" },
      },
      select: { id: true },
    });
    if (!target) {
      throw new DomainRuleError("RAD-007", "Целевой кандидат для слияния недоступен", {
        mergeTargetId: "Обновите очередь и выберите другого кандидата",
      });
    }
  }
  if (command.decision !== "accept") return { organizationId: null, opportunityId: null };
  if (candidate.evidence.length === 0) {
    throw new DomainRuleError("RAD-003", "Перед принятием нужно проверить публичную страницу", {
      evidence: "Запустите L0-проверку",
    });
  }
  if (candidate.duplicateOrganizationId) {
    throw new DomainRuleError("RAD-002", "Домен уже привязан к организации", {
      decision: "Отклоните кандидата или объедините данны",
    });
  }
  const process = await transaction.processDefinition.findFirst({
    where: { status: "PUBLISHED" },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  if (!process) throw new ServiceUnavailableException("Нет опубликованной версии воронки");
  const organizationId = randomUUID();
  const opportunityId = randomUUID();
  const taskId = randomUUID();
  const dueAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  const priority = calculatePriority({ partnerScore: candidate.scoreTotal });
  const features = parseFeatures(candidate.featuresJson);
  const research = parseResearch(candidate.featuresJson);
  const brief = research?.brief ?? null;
  const decisionContacts = research?.decisionMakers.slice(0, 4) ?? [];
  const claimedChannels = new Set(
    decisionContacts.flatMap(({ email, phone }) => [email, phone]).filter(Boolean),
  );
  const directContacts =
    research?.contacts
      .filter(
        ({ type, value }) => (type === "email" || type === "phone") && !claimedChannels.has(value),
      )
      .slice(0, Math.max(0, 4 - decisionContacts.length)) ?? [];
  const latestEvidence = candidate.evidence.at(-1);
  await transaction.organization.create({
    data: {
      id: organizationId,
      name: candidate.name,
      segment: features.topic,
      ownerId: actor.id,
      domains: {
        create: {
          id: randomUUID(),
          hostNormalized: candidate.hostNormalized,
          isPrimary: true,
          source: `radar:${candidate.id}`,
          verifiedAt: candidate.evidence.at(-1)?.detectedAt ?? now,
        },
      },
    },
  });
  for (const [index, lead] of decisionContacts.entries()) {
    await transaction.contact.create({
      data: {
        id: randomUUID(),
        fullName: lead.fullName ?? lead.role,
        email: lead.email,
        phone: lead.phone,
        messenger: lead.profileUrl,
        source: `radar:${lead.sourceUrl}`,
        verifiedAt: research ? new Date(research.collectedAt) : now,
        restrictions: toJson({
          visibility: "public-business-contact",
          evidence: lead.evidence,
          confidence: lead.confidence,
          note: "Проверить актуальность адресата перед отправкой",
        }),
        organizationLinks: {
          create: {
            id: randomUUID(),
            organizationId,
            role: lead.role,
            department: lead.department,
            isPrimary: index === 0,
          },
        },
      },
    });
  }
  for (const [index, lead] of directContacts.entries()) {
    const role = brief?.likelyContactRoles[0] ?? "Представитель площадки";
    await transaction.contact.create({
      data: {
        id: randomUUID(),
        fullName:
          lead.type === "email"
            ? `Публичный email — ${candidate.name}`
            : `Публичный телефон — ${candidate.name}`,
        email: lead.type === "email" ? lead.value : null,
        phone: lead.type === "phone" ? lead.value : null,
        source: `radar:${lead.sourceUrl}`,
        verifiedAt: research ? new Date(research.collectedAt) : now,
        restrictions: toJson({
          visibility: "public-business-contact",
          note: "Проверить адресата перед отправкой",
        }),
        organizationLinks: {
          create: {
            id: randomUUID(),
            organizationId,
            role,
            department: role,
            isPrimary: decisionContacts.length === 0 && index === 0,
          },
        },
      },
    });
  }
  await transaction.opportunity.create({
    data: {
      id: opportunityId,
      organizationId,
      processVersion: process.version,
      ownerId: actor.id,
      type: "initial-embed",
      stageCode: brief ? "S2" : "S0",
      stageLabel: brief ? "Квалифицирован" : "Найден",
      score: candidate.scoreTotal,
      stageData: toJson({
        dataSource: candidate.source,
        researchCheckedAt:
          research?.collectedAt ?? latestEvidence?.detectedAt.toISOString() ?? now.toISOString(),
        geography: features.geography ?? "Не определена",
        videoPlayerType: latestEvidence?.playerType ?? "Плеер не подтверждён",
        priorityReason: command.reason,
        ...(brief ? { rutubeUseCase: brief.rutubeUseCase } : {}),
      }),
    },
  });
  await transaction.task.create({
    data: {
      id: taskId,
      opportunityId,
      ownerId: actor.id,
      type: decisionContacts.length + directContacts.length > 0 ? "contact" : "research",
      title: (brief?.nextAction ?? `Исследовать кандидата из Радара: ${candidate.name}`).slice(
        0,
        200,
      ),
      dueAt,
      priorityScore: priority.score,
      priorityReasons: toJson(priority.reasons),
      status: TaskStatus.OPEN,
      source: `radar:${candidate.id}`,
    },
  });
  await transaction.opportunity.update({
    where: { id: opportunityId },
    data: { nextTaskId: taskId },
  });
  return { organizationId, opportunityId };
}

async function findCandidate(
  transaction: Prisma.TransactionClient,
  candidateId: string,
  actor: PersistenceActor,
) {
  const candidate = await transaction.radarCandidate.findFirst({
    where: { id: candidateId, ...radarCandidateScope(actor) },
    include: radarInclude,
  });
  if (!candidate) throw new RadarCandidateNotFoundError(candidateId);
  return candidate;
}

function mapCandidate(candidate: DbRadarCandidate): RadarCandidate {
  const snapshot = candidate.scoreSnapshots[0];
  const score: RadarScore = {
    total: candidate.scoreTotal,
    automaticTotal: candidate.scoreAutomaticTotal,
    manualAdjustment: candidate.scoreManualAdjustment,
    manualAdjustmentComment: candidate.scoreManualComment,
    priority: priority(candidate.scorePriority),
    modelVersion: candidate.scoreModelVersion,
    factors: snapshot ? parseFactors(snapshot.factorsJson) : [],
    calculatedAt: snapshot?.calculatedAt.toISOString() ?? candidate.updatedAt.toISOString(),
  };
  return {
    id: candidate.id,
    name: candidate.name,
    source: candidate.source,
    inputUrl: candidate.inputUrl,
    pageUrl: candidate.pageUrl,
    hostNormalized: candidate.hostNormalized,
    status: candidateStatus(candidate.status),
    duplicateOrganization: candidate.duplicateOrganization,
    duplicateCandidate: candidate.duplicateCandidate,
    inspectionPending: candidate.inspectionRequestedAt !== null,
    features: parseFeatures(candidate.featuresJson),
    research: parseResearch(candidate.featuresJson),
    evidence: candidate.evidence.map(mapEvidence),
    decisions: candidate.decisions.map((decision): RadarDecision => ({
      id: decision.id,
      decision: decisionType(decision.decision),
      reason: decision.reason,
      reasonCode: rejectReasonCode(decision.reasonCode),
      comment: decision.comment,
      deferUntil: decision.deferUntil?.toISOString() ?? null,
      mergeTargetId: decision.mergeTargetId,
      scoreAtDecision: decision.scoreAtDecision,
      formulaVersion: decision.formulaVersion,
      decidedAt: decision.decidedAt.toISOString(),
      decidedBy: { id: decision.actor.id, name: decision.actor.displayName },
    })),
    score,
    deferUntil: candidate.deferUntil?.toISOString() ?? null,
    rejectionReason: candidate.rejectionReason,
    rejectionComment: candidate.rejectionComment,
    mergedIntoCandidateId: candidate.mergedIntoCandidateId,
    acceptedOrganizationId: candidate.acceptedOrganizationId,
    acceptedOpportunityId: candidate.acceptedOpportunityId,
    version: candidate.version,
    createdAt: candidate.createdAt.toISOString(),
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

function mapEvidence(evidence: DbRadarCandidate["evidence"][number]) {
  const detectedPlayers = parseDetectedPlayers(evidence.detectedPlayersJson);
  return {
    id: evidence.id,
    pageUrl: evidence.pageUrl,
    status: evidenceStatus(evidence.status),
    playerType: evidence.playerType,
    detectedAt: evidence.detectedAt.toISOString(),
    method: evidence.method === "manual" ? ("manual" as const) : ("l0-html" as const),
    confidence: confidence(evidence.confidence),
    httpStatus: evidence.httpStatus,
    playerFound: evidence.playerFound,
    embedUrl: evidence.embedUrl,
    errorCode: evidence.errorCode,
    detectedPlayers,
    competitorPlayerDetected: detectedPlayers.some(({ competitor }) => competitor),
  };
}

function parseDetectedPlayers(value: Prisma.JsonValue | null): RadarDetectedPlayer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.vendor !== "string" ||
      typeof record.label !== "string" ||
      typeof record.competitor !== "boolean" ||
      (record.via !== "static" && record.via !== "rendered")
    ) {
      return [];
    }
    return [
      {
        vendor: record.vendor,
        label: record.label,
        competitor: record.competitor,
        via: record.via,
        sampleUrl: typeof record.sampleUrl === "string" ? record.sampleUrl : null,
      },
    ];
  });
}

function scoreColumns(score: RadarScore) {
  return {
    scoreTotal: score.total,
    scoreAutomaticTotal: score.automaticTotal,
    scoreManualAdjustment: score.manualAdjustment,
    scoreManualComment: score.manualAdjustmentComment,
    scorePriority: score.priority.toUpperCase(),
    scoreModelVersion: score.modelVersion,
  };
}

function scoreSnapshotData(score: RadarScore) {
  return {
    id: randomUUID(),
    total: score.total,
    automaticTotal: score.automaticTotal,
    manualAdjustment: score.manualAdjustment,
    manualComment: score.manualAdjustmentComment,
    priority: score.priority.toUpperCase(),
    modelVersion: score.modelVersion,
    factorsJson: toJson(score.factors),
    calculatedAt: new Date(score.calculatedAt),
  };
}

async function recordMutation(
  transaction: Prisma.TransactionClient,
  actorId: string,
  response: RadarCandidate,
  eventType: string,
  now: Date,
) {
  await transaction.auditLog.create({
    data: {
      id: randomUUID(),
      actorId,
      action: eventType,
      entityType: "RadarCandidate",
      entityId: response.id,
      afterJson: toJson(response),
      occurredAt: now,
    },
  });
  await transaction.outboxEvent.create({
    data: {
      id: randomUUID(),
      eventType,
      aggregateType: "RadarCandidate",
      aggregateId: response.id,
      aggregateVersion: response.version,
      payload: toJson(response),
      occurredAt: now,
    },
  });
}

function lockHost(transaction: Prisma.TransactionClient, teamId: string, host: string) {
  return transaction.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`radar-host:${teamId}:${host}`}, 0))
  `);
}

function lockCandidate(transaction: Prisma.TransactionClient, candidateId: string) {
  return transaction.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`radar-candidate:${candidateId}`}, 0))
  `);
}

function assertMutable(candidate: DbRadarCandidate) {
  if (["ACCEPTED", "REJECTED", "MERGED"].includes(candidate.status)) {
    throw new RadarCandidateStateError(
      `Кандидат уже находится в конечном статусе ${candidate.status.toLocaleLowerCase("en-US")}`,
    );
  }
}

function assertVersion(current: number, requested: number) {
  if (current !== requested) throw new RadarCandidateVersionConflictError(current);
}

function decisionStatus(decision: RadarCandidateDecisionCommand["decision"]) {
  return { accept: "ACCEPTED", defer: "DEFERRED", reject: "REJECTED", merge: "MERGED" }[decision];
}

function parseReplay(value: Prisma.JsonValue, key: string): RadarCandidate {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.evidence)) {
    throw new IdempotencyInProgressError(key);
  }
  return {
    ...(value as unknown as RadarCandidate),
    research: isRecord(value.research)
      ? {
          ...(value.research as unknown as RadarResearch),
          decisionMakers: Array.isArray(value.research.decisionMakers)
            ? (value.research.decisionMakers as unknown as RadarResearch["decisionMakers"])
            : [],
        }
      : null,
  };
}

function parseFeatures(value: Prisma.JsonValue): RadarCandidateFeatures {
  if (!isRecord(value)) {
    return {
      topic: null,
      language: null,
      geography: null,
      publicationFrequency: "unknown",
      contactsFound: false,
      cms: null,
      estimatedVideoPagesMin: null,
      estimatedVideoPagesMax: null,
      trafficEstimate: null,
    };
  }
  return value as unknown as RadarCandidateFeatures;
}

function parseResearch(value: Prisma.JsonValue): RadarResearch | null {
  if (!isRecord(value) || !isRecord(value._research)) return null;
  const research = value._research;
  if (
    (research.method !== "html-signals-v1" && research.method !== "site-intelligence-v2") ||
    typeof research.pageUrl !== "string" ||
    typeof research.collectedAt !== "string" ||
    !Array.isArray(research.signals) ||
    !Array.isArray(research.contacts) ||
    !Array.isArray(research.videoPages) ||
    !isRecord(research.brief) ||
    !Array.isArray(research.notes)
  )
    return null;
  return {
    ...(research as unknown as RadarResearch),
    decisionMakers: Array.isArray(research.decisionMakers)
      ? (research.decisionMakers as unknown as RadarResearch["decisionMakers"])
      : [],
  };
}

function serializeFeatures(features: RadarCandidateFeatures, research: RadarResearch | null) {
  return toJson({ ...features, _research: research });
}

function parseFactors(value: Prisma.JsonValue): RadarScoreFactor[] {
  return Array.isArray(value) ? (value as unknown as RadarScoreFactor[]) : [];
}

function candidateStatus(value: string): RadarCandidateStatus {
  const normalized = value.toLocaleLowerCase("en-US");
  return ["new", "ready", "deferred", "rejected", "accepted", "merged"].includes(normalized)
    ? (normalized as RadarCandidateStatus)
    : "new";
}

function evidenceStatus(value: string): RadarEvidenceStatus {
  const normalized = value.toLocaleLowerCase("en-US");
  return ["found", "not_found", "blocked", "unknown"].includes(normalized)
    ? (normalized as RadarEvidenceStatus)
    : "unknown";
}

function confidence(value: string): RadarConfidence {
  const normalized = value.toLocaleLowerCase("en-US");
  return normalized === "high" || normalized === "medium" ? normalized : "low";
}

function priority(value: string): RadarPriority {
  const normalized = value.toLocaleLowerCase("en-US");
  return normalized === "high" || normalized === "medium" ? normalized : "low";
}

function rejectReasonCode(value: string | null): RadarRejectReasonCode | null {
  return value && radarRejectReasonCodes.includes(value as RadarRejectReasonCode)
    ? (value as RadarRejectReasonCode)
    : null;
}

function decisionType(value: string): RadarDecision["decision"] {
  const normalized = value.toLocaleLowerCase("en-US");
  return normalized === "accept" || normalized === "defer" || normalized === "merge"
    ? normalized
    : "reject";
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
