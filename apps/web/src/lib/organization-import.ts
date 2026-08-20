import type {
  CommitOrganizationImportCommand,
  OrganizationImportDecision,
  OrganizationImportJob,
  OrganizationImportRow,
} from "@embed-os/contracts";

export type ImportResolutions = Record<number, "create" | "skip" | undefined>;

export function unresolvedImportRows(
  job: OrganizationImportJob,
  resolutions: ImportResolutions,
) {
  return job.rows.filter((row) =>
    row.decision === "conflict" && !resolutions[row.rowNo]);
}

export function buildImportCommand(
  job: OrganizationImportJob,
  resolutions: ImportResolutions,
): CommitOrganizationImportCommand {
  return {
    resolutions: job.rows.flatMap((row) => {
      const decision = resolutions[row.rowNo];
      return row.decision === "conflict" && decision
        ? [{ rowNo: row.rowNo, decision }]
        : [];
    }),
  };
}

export function importDecisionLabel(decision: OrganizationImportDecision) {
  const labels: Record<OrganizationImportDecision, string> = {
    create: "Создать",
    update: "Обновить",
    skip: "Пропустить",
    conflict: "Конфликт",
  };
  return labels[decision];
}

export function importRowMessage(row: OrganizationImportRow) {
  const errors = Object.values(row.fieldErrors);
  if (errors.length > 0) return errors.join("; ");
  if (row.warnings.length > 0) return row.warnings.join("; ");
  if (row.decision === "update" && row.matchedOrganization) {
    return `Найден домен: ${row.matchedOrganization.name}`;
  }
  if (row.decision === "skip") return "Изменений нет";
  if (row.decision === "create") return "Новая организация";
  return "Требуется решение";
}
