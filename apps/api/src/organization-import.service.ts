import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  CommitOrganizationImportCommand,
  OrganizationImportJob,
  OrganizationImportRow,
} from "@embed-os/contracts";
import {
  classifyOrganizationImportRows,
  parseCommitOrganizationImportCommand,
  parseOrganizationImportFile,
  summarizeImportRows,
  type ExistingImportOrganization,
  type OrganizationImportFile,
} from "./application/organization-import.js";
import { IdempotencyConflictError } from "./application/idempotency.js";
import type { OrganizationImportPort } from "./organization-import.port.js";
import { TodayService } from "./today.service.js";

export class OrganizationImportNotFoundError extends Error {
  readonly code = "ORGANIZATION_IMPORT_NOT_FOUND";
  constructor(readonly jobId: string) {
    super(`Импорт ${jobId} не найден`);
    this.name = "OrganizationImportNotFoundError";
  }
}

export class OrganizationImportStateError extends Error {
  readonly code = "ORGANIZATION_IMPORT_STATE_CONFLICT";
  constructor(readonly status: OrganizationImportJob["status"]) {
    super(`Импорт уже находится в состоянии ${status}`);
    this.name = "OrganizationImportStateError";
  }
}

export class OrganizationImportResolutionError extends Error {
  readonly code = "ORGANIZATION_IMPORT_RESOLUTION_REQUIRED";
  readonly fieldErrors: Record<string, string>;
  constructor(rows: OrganizationImportRow[]) {
    super("Разрешите каждый конфликт перед применением импорта");
    this.name = "OrganizationImportResolutionError";
    this.fieldErrors = Object.fromEntries(rows.map(({ rowNo }) => [
      `rows.${rowNo}`,
      "Выберите «Создать отдельно» или «Пропустить»",
    ]));
  }
}

interface ImportedOrganization extends ExistingImportOrganization {
  source: string;
}

@Injectable()
export class OrganizationImportService implements OrganizationImportPort {
  private readonly jobs = new Map<string, OrganizationImportJob>();
  private readonly importedOrganizations = new Map<string, ImportedOrganization>();
  private readonly idempotency = new Map<string, { hash: string; response: OrganizationImportJob }>();

  constructor(
    @Inject(TodayService) private readonly today: TodayService,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {}

  async preview(file: OrganizationImportFile): Promise<OrganizationImportJob> {
    const parsed = await parseOrganizationImportFile(file);
    const rows = classifyOrganizationImportRows(parsed.rows, this.existingOrganizations());
    const createdAt = this.clock().toISOString();
    const job: OrganizationImportJob = {
      id: `import-${randomUUID()}`,
      fileName: file.fileName,
      format: parsed.format,
      sourceHash: parsed.sourceHash,
      status: "preview",
      summary: summarizeImportRows(rows),
      warnings: parsed.warnings,
      rows,
      createdAt,
      completedAt: null,
    };
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async commit(
    jobId: string,
    input: CommitOrganizationImportCommand | unknown,
    idempotencyKey: string,
  ): Promise<OrganizationImportJob> {
    const command = parseCommitOrganizationImportCommand(input);
    const hash = commandHash(command);
    const scope = `commit:${jobId}:${idempotencyKey}`;
    const replay = this.idempotency.get(scope);
    if (replay) {
      if (replay.hash !== hash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const job = this.jobs.get(jobId);
    if (!job) throw new OrganizationImportNotFoundError(jobId);
    if (job.status !== "preview") throw new OrganizationImportStateError(job.status);
    const resolutions = new Map(
      (command.resolutions ?? []).map(({ rowNo, decision }) => [rowNo, decision]),
    );
    const unresolved = job.rows.filter((row) =>
      row.decision === "conflict" && !resolutions.has(row.rowNo));
    if (unresolved.length > 0) throw new OrganizationImportResolutionError(unresolved);
    const now = this.clock().toISOString();
    const rows = job.rows.map((row) => this.applyRow(row, resolutions.get(row.rowNo), now));
    const response: OrganizationImportJob = {
      ...job,
      status: "committed",
      rows,
      summary: summarizeImportRows(rows),
      completedAt: now,
    };
    this.jobs.set(jobId, structuredClone(response));
    this.idempotency.set(scope, { hash, response: structuredClone(response) });
    return structuredClone(response);
  }

  async cancel(jobId: string, idempotencyKey: string): Promise<OrganizationImportJob> {
    const scope = `cancel:${jobId}:${idempotencyKey}`;
    const replay = this.idempotency.get(scope);
    if (replay) return structuredClone(replay.response);
    const job = this.jobs.get(jobId);
    if (!job) throw new OrganizationImportNotFoundError(jobId);
    if (job.status !== "preview") throw new OrganizationImportStateError(job.status);
    const response: OrganizationImportJob = {
      ...job,
      status: "cancelled",
      completedAt: this.clock().toISOString(),
    };
    this.jobs.set(jobId, structuredClone(response));
    this.idempotency.set(scope, { hash: "cancel", response: structuredClone(response) });
    return structuredClone(response);
  }

  private applyRow(
    row: OrganizationImportRow,
    resolution: "create" | "skip" | undefined,
    appliedAt: string,
  ): OrganizationImportRow {
    const effectiveDecision = row.decision === "conflict" ? resolution : row.decision;
    if (effectiveDecision === "skip" || effectiveDecision === undefined) {
      return { ...row, resolvedDecision: "skip", appliedAt: null };
    }
    if (effectiveDecision === "update" && row.matchedOrganization) {
      const current = this.existingOrganizations().find(({ id }) =>
        id === row.matchedOrganization?.id);
      if (current) {
        this.importedOrganizations.set(current.id, {
          ...current,
          name: row.values.organization_name,
          segment: row.values.segment || current.segment,
          source: row.values.source,
        });
      }
      return {
        ...row,
        resolvedDecision: "update",
        entityId: row.matchedOrganization.id,
        appliedAt,
      };
    }
    const organizationId = `org-${randomUUID()}`;
    this.importedOrganizations.set(organizationId, {
      id: organizationId,
      name: row.values.organization_name,
      domain: row.normalizedDomain ?? row.values.domain,
      segment: row.values.segment || null,
      source: row.values.source,
    });
    return { ...row, resolvedDecision: "create", entityId: organizationId, appliedAt };
  }

  private existingOrganizations(): ExistingImportOrganization[] {
    const organizations = new Map<string, ExistingImportOrganization>();
    for (const action of this.today.getToday().actions) {
      organizations.set(action.organizationId, {
        id: action.organizationId,
        name: action.organizationName,
        domain: action.domain,
        segment: action.organizationSegment ?? null,
      });
    }
    for (const organization of this.importedOrganizations.values()) {
      organizations.set(organization.id, organization);
    }
    return [...organizations.values()];
  }
}

function commandHash(command: CommitOrganizationImportCommand) {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}
