import { describe, expect, it } from "vitest";
import type { OrganizationImportJob, OrganizationImportRow } from "@embed-os/contracts";
import {
  buildImportCommand,
  importRowMessage,
  unresolvedImportRows,
} from "./organization-import.js";

function row(
  rowNo: number,
  decision: OrganizationImportRow["decision"],
  allowedDecisions: OrganizationImportRow["allowedDecisions"] = [],
): OrganizationImportRow {
  return {
    rowNo,
    values: {
      organization_name: "Медиа",
      domain: "media.ru",
      segment: "",
      owner_email: "",
      stage: "S0",
      contact_name: "",
      contact_role: "",
      contact_email: "",
      contact_phone: "",
      source: "test",
      last_interaction_at: "",
      next_action: "",
      next_action_due_at: "",
      notes: "",
    },
    normalizedDomain: "media.ru",
    decision,
    resolvedDecision: null,
    allowedDecisions,
    matchedOrganization: null,
    fieldErrors: {},
    warnings: [],
    errorCode: null,
    entityId: null,
    appliedAt: null,
  };
}

function job(rows: OrganizationImportRow[]): OrganizationImportJob {
  return {
    id: "import-1",
    fileName: "partners.csv",
    format: "csv",
    sourceHash: "hash",
    status: "preview",
    summary: { total: rows.length, create: 0, update: 0, skip: 0, conflict: 0, applied: 0 },
    warnings: [],
    rows,
    createdAt: "2026-08-18T00:00:00.000Z",
    completedAt: null,
  };
}

describe("organization import UI state", () => {
  it("requires a resolution for every conflicting row", () => {
    const preview = job([row(2, "create"), row(3, "conflict", ["create", "skip"])]);

    expect(unresolvedImportRows(preview, {})).toHaveLength(1);
    expect(unresolvedImportRows(preview, { 3: "skip" })).toHaveLength(0);
    expect(buildImportCommand(preview, { 3: "skip" })).toEqual({
      resolutions: [{ rowNo: 3, decision: "skip" }],
    });
  });

  it("prioritizes field validation errors in the row protocol", () => {
    const invalid = {
      ...row(4, "conflict", ["skip"]),
      fieldErrors: { domain: "Укажите корректный домен" },
      warnings: ["Дубль"],
    };

    expect(importRowMessage(invalid)).toBe("Укажите корректный домен");
  });
});
