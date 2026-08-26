import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  RadarCandidate,
  RadarCandidateDecisionCommand,
  RadarDecision,
  RadarImportResult,
  RadarPayload,
} from "@embed-os/contracts";
import {
  calculatePartnerScore,
  DomainRuleError,
  emptyRadarFeatures,
  normalizeRadarTarget,
  parseCreateRadarCandidateCommand,
  parseRadarDecisionCommand,
  parseRadarScoreAdjustmentCommand,
} from "@embed-os/domain";
import { IdempotencyConflictError } from "./application/idempotency.js";
import { parseRadarImportFile } from "./application/radar-import.js";
import type { OrganizationImportFile } from "./application/organization-import.js";
import { RADAR_INSPECTOR, type RadarInspector } from "./monitoring/radar-page-inspector.js";
import {
  enrichRadarResearchWithChanges,
  mergeRadarFeatures,
} from "./monitoring/radar-feature-extractor.js";
import {
  RADAR_TRAFFIC_STATUS,
  type RadarTrafficStatus,
} from "./monitoring/radar-traffic-provider.js";
import type { RadarPort } from "./radar.port.js";
import { TodayService } from "./today.service.js";

export class RadarCandidateNotFoundError extends Error {
  readonly code = "RADAR_CANDIDATE_NOT_FOUND";
  constructor(readonly candidateId: string) {
    super(`Кандидат ${candidateId} не найден`);
    this.name = "RadarCandidateNotFoundError";
  }
}

export class RadarCandidateVersionConflictError extends Error {
  readonly code = "RADAR_CANDIDATE_VERSION_CONFLICT";
  constructor(readonly currentVersion: number) {
    super(`Кандидат уже изменён. Актуальная версия: ${currentVersion}`);
    this.name = "RadarCandidateVersionConflictError";
  }
}

export class RadarCandidateStateError extends Error {
  readonly code = "RADAR_CANDIDATE_STATE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "RadarCandidateStateError";
  }
}

type StoredResponse = { requestHash: string; response: RadarCandidate };

@Injectable()
export class RadarService implements RadarPort {
  private readonly candidates = new Map<string, RadarCandidate>();
  /** Unfinished background inspections; each resolves to `true` on success. */
  private readonly pendingInspections = new Set<Promise<boolean>>();
  private readonly idempotency = new Map<string, StoredResponse>();
  private readonly importIdempotency = new Map<
    string,
    { requestHash: string; response: RadarImportResult }
  >();

  constructor(
    @Inject(TodayService) private readonly today: TodayService,
    @Inject(RADAR_INSPECTOR) private readonly inspector: RadarInspector,
    @Optional() private readonly clock: () => Date = () => new Date(),
    @Optional()
    @Inject(RADAR_TRAFFIC_STATUS)
    private readonly trafficStatus?: RadarTrafficStatus,
  ) {}

  list(): RadarPayload {
    const candidates = [...this.candidates.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((candidate) => structuredClone(candidate));
    return {
      generatedAt: this.clock().toISOString(),
      total: candidates.length,
      trafficProvider: this.trafficStatus ?? { configured: false, provider: null },
      candidates,
    };
  }

  create(input: unknown, idempotencyKey: string): RadarCandidate {
    const command = parseCreateRadarCandidateCommand(input);
    const requestHash = hash(command);
    return this.idempotent(`create:${idempotencyKey}`, idempotencyKey, requestHash, () => {
      const normalized = normalizeRadarTarget(command.url);
      const duplicateOrganization = this.findOrganization(normalized.hostNormalized);
      const duplicateCandidate = [...this.candidates.values()].find(
        (candidate) =>
          candidate.hostNormalized === normalized.hostNormalized &&
          candidate.status !== "rejected" &&
          candidate.status !== "merged",
      );
      const now = this.clock().toISOString();
      const features = emptyRadarFeatures(command);
      const candidate: RadarCandidate = {
        id: `radar-${randomUUID()}`,
        name: command.name,
        source: command.source,
        inputUrl: command.url,
        pageUrl: normalized.pageUrl,
        hostNormalized: normalized.hostNormalized,
        status: "new",
        duplicateOrganization,
        duplicateCandidate: duplicateCandidate
          ? { id: duplicateCandidate.id, name: duplicateCandidate.name }
          : null,
        inspectionPending: false,
        features,
        research: null,
        evidence: [],
        decisions: [],
        score: calculatePartnerScore({
          features,
          latestEvidence: null,
          duplicateOrganization: duplicateOrganization !== null,
          duplicateCandidate: duplicateCandidate !== undefined,
          calculatedAt: this.clock(),
        }),
        deferUntil: null,
        rejectionReason: null,
        rejectionComment: null,
        mergedIntoCandidateId: null,
        acceptedOrganizationId: null,
        acceptedOpportunityId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.candidates.set(candidate.id, structuredClone(candidate));
      return candidate;
    });
  }

  async import(file: OrganizationImportFile, idempotencyKey: string): Promise<RadarImportResult> {
    const requestHash = createHash("sha256").update(file.buffer).digest("hex");
    const replay = this.importIdempotency.get(idempotencyKey);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
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
        const created = this.create(row.command, `${idempotencyKey}:${row.rowNo}`);
        rows.push({
          rowNo: row.rowNo,
          status:
            created.duplicateOrganization || created.duplicateCandidate ? "skipped" : "created",
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
    const response: RadarImportResult = {
      fileName: parsed.fileName,
      format: parsed.format,
      total: rows.length,
      created: rows.filter(({ status }) => status === "created").length,
      skipped: rows.filter(({ status }) => status === "skipped").length,
      failed: rows.filter(({ status }) => status === "failed").length,
      warnings: parsed.warnings,
      rows,
    };
    this.importIdempotency.set(idempotencyKey, {
      requestHash,
      response: structuredClone(response),
    });
    return structuredClone(response);
  }

  async requestInspection(candidateId: string, idempotencyKey: string): Promise<RadarCandidate> {
    const requestHash = hash({ candidateId });
    return this.idempotent(
      `inspect-request:${candidateId}:${idempotencyKey}`,
      idempotencyKey,
      requestHash,
      () => {
        const candidate = this.requireMutable(candidateId);
        const updated: RadarCandidate = {
          ...candidate,
          inspectionPending: true,
          version: candidate.version + 1,
          updatedAt: this.clock().toISOString(),
        };
        this.candidates.set(candidateId, structuredClone(updated));
        this.scheduleInspection(candidateId);
        return updated;
      },
    );
  }

  async inspect(candidateId: string, idempotencyKey: string): Promise<RadarCandidate> {
    const scope = `inspect:${candidateId}:${idempotencyKey}`;
    const requestHash = hash({ candidateId });
    const replay = this.idempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const candidate = this.requireMutable(candidateId);
    const observation = await this.inspector.inspect(candidate.pageUrl);
    const updated = this.applyInspection(candidate, observation);
    this.candidates.set(candidateId, structuredClone(updated));
    this.idempotency.set(scope, { requestHash, response: structuredClone(updated) });
    return structuredClone(updated);
  }

  async processRequestedInspections(): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    while (this.pendingInspections.size > 0) {
      const tasks = [...this.pendingInspections];
      for (const task of tasks) this.pendingInspections.delete(task);
      for (const succeeded of await Promise.all(tasks)) {
        if (succeeded) processed += 1;
        else failed += 1;
      }
    }
    return { processed, failed };
  }

  /** Schedules a background inspection in the same process (dev mode). */
  private scheduleInspection(candidateId: string) {
    const task = (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return this.runRequestedInspection(candidateId);
    })();
    this.pendingInspections.add(task);
    void task.finally(() => this.pendingInspections.delete(task));
  }

  /** Executes one background inspection; a failure only clears the flag. */
  private async runRequestedInspection(candidateId: string): Promise<boolean> {
    try {
      const candidate = this.candidates.get(candidateId);
      if (!candidate) return false;
      const observation = await this.inspector.inspect(candidate.pageUrl);
      const current = this.candidates.get(candidateId);
      if (!current || this.isTerminal(current.status)) {
        this.clearInspectionPending(candidateId);
        return false;
      }
      this.candidates.set(candidateId, structuredClone(this.applyInspection(current, observation)));
      return true;
    } catch (error) {
      this.clearInspectionPending(candidateId);
      console.error(
        JSON.stringify({
          event: "radar.inspection-failed",
          candidateId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  }

  private applyInspection(
    candidate: RadarCandidate,
    observation: Awaited<ReturnType<RadarInspector["inspect"]>>,
  ): RadarCandidate {
    const { featureExtraction, ...evidenceObservation } = observation;
    const evidence = {
      id: `evidence-${randomUUID()}`,
      ...evidenceObservation,
      detectedAt: observation.detectedAt.toISOString(),
    };
    const features = featureExtraction
      ? mergeRadarFeatures(candidate.features, featureExtraction.features)
      : candidate.features;
    return {
      ...candidate,
      pageUrl: observation.pageUrl,
      status: "ready",
      inspectionPending: false,
      features,
      research: featureExtraction
        ? enrichRadarResearchWithChanges(candidate.research, featureExtraction.research)
        : candidate.research,
      evidence: [...candidate.evidence, evidence],
      version: candidate.version + 1,
      updatedAt: this.clock().toISOString(),
      score: calculatePartnerScore({
        features,
        latestEvidence: evidence,
        duplicateOrganization: candidate.duplicateOrganization !== null,
        duplicateCandidate: candidate.duplicateCandidate !== null,
        manualAdjustment: candidate.score.manualAdjustment,
        manualAdjustmentComment: candidate.score.manualAdjustmentComment,
        calculatedAt: this.clock(),
      }),
    };
  }

  private clearInspectionPending(candidateId: string) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate?.inspectionPending) return;
    this.candidates.set(candidateId, {
      ...candidate,
      inspectionPending: false,
      updatedAt: this.clock().toISOString(),
    });
  }

  private isTerminal(status: RadarCandidate["status"]) {
    return status === "accepted" || status === "rejected" || status === "merged";
  }

  decide(candidateId: string, input: unknown, idempotencyKey: string): RadarCandidate {
    const command = parseRadarDecisionCommand(input);
    const requestHash = hash(command);
    return this.idempotent(
      `decide:${candidateId}:${idempotencyKey}`,
      idempotencyKey,
      requestHash,
      () => {
        const candidate = this.requireMutable(candidateId);
        this.assertVersion(candidate, command.version);
        const now = this.clock();
        const decision: RadarDecision = {
          id: `radar-decision-${randomUUID()}`,
          decision: command.decision,
          reason: command.reason,
          reasonCode: command.reasonCode ?? null,
          comment: command.comment ?? null,
          deferUntil: command.deferUntil ?? null,
          mergeTargetId: command.mergeTargetId ?? null,
          // Score feedback loop: the decision keeps the score and formula
          // version that the manager actually saw at decision time.
          scoreAtDecision: candidate.score.total,
          formulaVersion: candidate.score.modelVersion,
          decidedAt: now.toISOString(),
          decidedBy: { id: "user-anna", name: "Анна Соколова" },
        };
        const updated = this.applyDecision(candidate, command, decision, now);
        this.candidates.set(candidateId, structuredClone(updated));
        return updated;
      },
    );
  }

  adjustScore(candidateId: string, input: unknown, idempotencyKey: string): RadarCandidate {
    const command = parseRadarScoreAdjustmentCommand(input);
    const requestHash = hash(command);
    return this.idempotent(
      `score:${candidateId}:${idempotencyKey}`,
      idempotencyKey,
      requestHash,
      () => {
        const candidate = this.requireMutable(candidateId);
        this.assertVersion(candidate, command.version);
        const latestEvidence = candidate.evidence.at(-1) ?? null;
        const updated: RadarCandidate = {
          ...candidate,
          version: candidate.version + 1,
          updatedAt: this.clock().toISOString(),
          score: calculatePartnerScore({
            features: candidate.features,
            latestEvidence,
            duplicateOrganization: candidate.duplicateOrganization !== null,
            duplicateCandidate: candidate.duplicateCandidate !== null,
            manualAdjustment: command.adjustment,
            manualAdjustmentComment: command.comment,
            calculatedAt: this.clock(),
          }),
        };
        this.candidates.set(candidateId, structuredClone(updated));
        return updated;
      },
    );
  }

  private applyDecision(
    candidate: RadarCandidate,
    command: RadarCandidateDecisionCommand,
    decision: RadarDecision,
    now: Date,
  ): RadarCandidate {
    const common = {
      ...candidate,
      decisions: [...candidate.decisions, decision],
      version: candidate.version + 1,
      updatedAt: now.toISOString(),
    };
    if (command.decision === "defer") {
      return { ...common, status: "deferred", deferUntil: command.deferUntil ?? null };
    }
    if (command.decision === "reject") {
      return {
        ...common,
        inspectionPending: false,
        status: "rejected",
        rejectionReason: command.reason,
        rejectionComment: command.comment ?? null,
      };
    }
    if (command.decision === "merge") {
      if (command.mergeTargetId === candidate.id) {
        throw new DomainRuleError("RAD-007", "Кандидата нельзя объединить с самим собой", {
          mergeTargetId: "Выберите другого кандидата",
        });
      }
      const target = this.candidates.get(command.mergeTargetId ?? "");
      if (!target || target.status === "merged") {
        throw new DomainRuleError("RAD-007", "Целевой кандидат для слияния недоступен", {
          mergeTargetId: "Обновите список и выберите другого кандидата",
        });
      }
      return {
        ...common,
        inspectionPending: false,
        status: "merged",
        mergedIntoCandidateId: target.id,
      };
    }
    if (candidate.evidence.length === 0) {
      throw new DomainRuleError("RAD-003", "Перед принятием нужно проверить публичную страницу", {
        evidence: "Запустите L0-проверку",
      });
    }
    if (candidate.duplicateOrganization) {
      throw new DomainRuleError("RAD-002", "Домен уже привязан к организации", {
        decision: "Отклоните кандидата или объедините данные вручную",
      });
    }
    const organizationId = `org-${randomUUID()}`;
    const opportunityId = `opp-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const dueAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
    this.today.createRadarCandidateAction({
      taskId,
      organizationId,
      opportunityId,
      organizationName: candidate.name,
      domain: candidate.hostNormalized,
      source: candidate.source,
      topic: candidate.features.topic,
      geography: candidate.features.geography,
      score: candidate.score.total,
      playerType: candidate.evidence.at(-1)?.playerType ?? "Плеер не подтверждён",
      priorityReason: command.reason,
      research: candidate.research,
      dueAt,
    });
    return {
      ...common,
      inspectionPending: false,
      status: "accepted",
      acceptedOrganizationId: organizationId,
      acceptedOpportunityId: opportunityId,
    };
  }

  private findOrganization(host: string) {
    const action = this.today
      .getToday()
      .actions.find(
        ({ domain }) => domain.toLocaleLowerCase("en-US").replace(/^www\./, "") === host,
      );
    return action ? { id: action.organizationId, name: action.organizationName } : null;
  }

  private requireMutable(candidateId: string) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new RadarCandidateNotFoundError(candidateId);
    if (
      candidate.status === "accepted" ||
      candidate.status === "rejected" ||
      candidate.status === "merged"
    ) {
      throw new RadarCandidateStateError(
        `Кандидат уже находится в конечном статусе ${candidate.status}`,
      );
    }
    return candidate;
  }

  private assertVersion(candidate: RadarCandidate, version: number) {
    if (candidate.version !== version)
      throw new RadarCandidateVersionConflictError(candidate.version);
  }

  private idempotent(
    scope: string,
    idempotencyKey: string,
    requestHash: string,
    action: () => RadarCandidate,
  ) {
    const replay = this.idempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const response = action();
    this.idempotency.set(scope, { requestHash, response: structuredClone(response) });
    return structuredClone(response);
  }
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
