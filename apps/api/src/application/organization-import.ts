import { createHash } from "node:crypto";
import { readSheet, type CellValue } from "read-excel-file/node";
import {
  type CommitOrganizationImportCommand,
  opportunityStageCatalog,
  organizationImportFields,
  type OrganizationImportField,
  type OrganizationImportRow,
  type OrganizationImportValues,
} from "@embed-os/contracts";

export const MAX_IMPORT_ROWS = 10_000;

export interface OrganizationImportFile {
  fileName: string;
  buffer: Buffer;
}

export interface ParsedOrganizationImportFile {
  format: "csv" | "xlsx";
  sourceHash: string;
  rows: Array<{ rowNo: number; values: OrganizationImportValues }>;
  warnings: string[];
}

export interface ExistingImportOrganization {
  id: string;
  name: string;
  domain: string;
  segment: string | null;
}

export class OrganizationImportFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "OrganizationImportFileError";
  }
}

export async function parseOrganizationImportFile(
  file: OrganizationImportFile,
): Promise<ParsedOrganizationImportFile> {
  const format = fileFormat(file.fileName);
  const matrix = format === "csv"
    ? parseCsv(file.buffer.toString("utf8"))
    : await parseXlsx(file.buffer);
  if (matrix.length === 0) {
    throw new OrganizationImportFileError("IMPORT_EMPTY", "Файл не содержит строк");
  }
  const headers = matrix[0]?.map((value) => normalizeHeader(value)) ?? [];
  const warnings: string[] = [];
  validateHeaders(headers, warnings);
  const rows = matrix.slice(1).flatMap((cells, index) => {
    if (cells.every((cell) => cell.trim().length === 0)) return [];
    const values = emptyValues();
    headers.forEach((header, column) => {
      if (isImportField(header)) values[header] = cells[column]?.trim() ?? "";
    });
    return [{ rowNo: index + 2, values }];
  });
  if (rows.length === 0) {
    throw new OrganizationImportFileError("IMPORT_EMPTY", "Файл не содержит данных");
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new OrganizationImportFileError(
      "IMPORT_TOO_MANY_ROWS",
      `В одном файле допускается не более ${MAX_IMPORT_ROWS} строк`,
    );
  }
  return {
    format,
    sourceHash: createHash("sha256").update(file.buffer).digest("hex"),
    rows,
    warnings,
  };
}

export function classifyOrganizationImportRows(
  rows: ParsedOrganizationImportFile["rows"],
  existingOrganizations: ExistingImportOrganization[],
): OrganizationImportRow[] {
  const byDomain = new Map(
    existingOrganizations.map((organization) => [normalizeDomain(organization.domain), organization]),
  );
  const byName = new Map<string, ExistingImportOrganization[]>();
  for (const organization of existingOrganizations) {
    const key = normalizeName(organization.name);
    byName.set(key, [...(byName.get(key) ?? []), organization]);
  }
  const seenDomains = new Map<string, number>();

  return rows.map(({ rowNo, values }) => {
    const fieldErrors = validateValues(values);
    const normalizedDomain = fieldErrors.domain ? null : normalizeDomain(values.domain);
    if (normalizedDomain && seenDomains.has(normalizedDomain)) {
      return previewRow({
        rowNo,
        values,
        normalizedDomain,
        fieldErrors,
        errorCode: "DUPLICATE_DOMAIN_IN_FILE",
        warnings: [`Домен уже встречался в строке ${seenDomains.get(normalizedDomain)}`],
        allowedDecisions: ["skip"],
      });
    }
    if (normalizedDomain) seenDomains.set(normalizedDomain, rowNo);
    if (Object.keys(fieldErrors).length > 0) {
      return previewRow({
        rowNo,
        values,
        normalizedDomain,
        fieldErrors,
        errorCode: "ROW_VALIDATION_FAILED",
        allowedDecisions: ["skip"],
      });
    }

    const domainMatch = normalizedDomain ? byDomain.get(normalizedDomain) : undefined;
    if (domainMatch) {
      const changes =
        domainMatch.name.trim() !== values.organization_name.trim() ||
        (values.segment.length > 0 && values.segment !== (domainMatch.segment ?? ""));
      return {
        ...previewRow({ rowNo, values, normalizedDomain, fieldErrors }),
        decision: changes ? "update" : "skip",
        matchedOrganization: { id: domainMatch.id, name: domainMatch.name },
        errorCode: changes ? null : "NO_CHANGES",
      };
    }

    const nameMatches = byName.get(normalizeName(values.organization_name)) ?? [];
    if (nameMatches.length > 0) {
      return {
        ...previewRow({
          rowNo,
          values,
          normalizedDomain,
          fieldErrors,
          errorCode: "AMBIGUOUS_NAME_MATCH",
          warnings: ["Название уже используется организацией с другим доменом"],
          allowedDecisions: ["create", "skip"],
        }),
        matchedOrganization: {
          id: nameMatches[0]?.id ?? "",
          name: nameMatches[0]?.name ?? values.organization_name,
        },
      };
    }

    return {
      ...previewRow({ rowNo, values, normalizedDomain, fieldErrors }),
      decision: "create",
    };
  });
}

export function summarizeImportRows(rows: OrganizationImportRow[]) {
  return {
    total: rows.length,
    create: rows.filter(({ decision }) => decision === "create").length,
    update: rows.filter(({ decision }) => decision === "update").length,
    skip: rows.filter(({ decision }) => decision === "skip").length,
    conflict: rows.filter(({ decision }) => decision === "conflict").length,
    applied: rows.filter(({ appliedAt }) => appliedAt !== null).length,
  };
}

export function normalizeDomain(value: string) {
  const trimmed = value.trim().toLocaleLowerCase("en-US");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const hostname = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
    if (
      !hostname.includes(".") ||
      hostname === "localhost" ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    ) return "";
    return hostname;
  } catch {
    return "";
  }
}

export function parseCommitOrganizationImportCommand(
  input: unknown,
): CommitOrganizationImportCommand {
  if (!isRecord(input)) {
    throw new OrganizationImportFileError(
      "IMPORT_RESOLUTION_INVALID",
      "Команда применения импорта должна быть объектом",
    );
  }
  const rawResolutions = input.resolutions ?? [];
  if (!Array.isArray(rawResolutions)) {
    throw new OrganizationImportFileError(
      "IMPORT_RESOLUTION_INVALID",
      "resolutions должен быть массивом",
    );
  }
  const rowNumbers = new Set<number>();
  const resolutions = rawResolutions.map((resolution) => {
    if (
      !isRecord(resolution) ||
      !Number.isInteger(resolution.rowNo) ||
      (resolution.decision !== "create" && resolution.decision !== "skip")
    ) {
      throw new OrganizationImportFileError(
        "IMPORT_RESOLUTION_INVALID",
        "Каждое решение должно содержать rowNo и действие create или skip",
      );
    }
    const rowNo = resolution.rowNo as number;
    if (rowNumbers.has(rowNo)) {
      throw new OrganizationImportFileError(
        "IMPORT_RESOLUTION_INVALID",
        `Решение для строки ${rowNo} передано повторно`,
      );
    }
    rowNumbers.add(rowNo);
    return { rowNo, decision: resolution.decision as "create" | "skip" };
  });
  return { resolutions };
}

function fileFormat(fileName: string): "csv" | "xlsx" {
  const lower = fileName.toLocaleLowerCase("en-US");
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".xlsx")) return "xlsx";
  throw new OrganizationImportFileError(
    "IMPORT_FORMAT_UNSUPPORTED",
    "Поддерживаются только файлы CSV и XLSX",
  );
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  try {
    const sheet = await readSheet(buffer);
    return sheet.map((row) => row.map(cellToString));
  } catch {
    throw new OrganizationImportFileError(
      "IMPORT_XLSX_INVALID",
      "Не удалось прочитать XLSX. Проверьте, что файл не повреждён и не защищён паролем",
    );
  }
}

function cellToString(value: CellValue | null): string {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return "";
  return String(value);
}

function parseCsv(source: string): string[][] {
  const text = source.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) {
    throw new OrganizationImportFileError(
      "IMPORT_CSV_INVALID",
      "В CSV обнаружено незакрытое поле в кавычках",
    );
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(source: string) {
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (let index = 0; index < firstLine.length; index += 1) {
    const character = firstLine[index];
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") commas += 1;
    else if (!quoted && character === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

function validateHeaders(headers: string[], warnings: string[]) {
  const supported = headers.filter(isImportField);
  const duplicates = supported.filter((header, index) => supported.indexOf(header) !== index);
  if (duplicates.length > 0) {
    throw new OrganizationImportFileError(
      "IMPORT_DUPLICATE_HEADER",
      `Повторяются колонки: ${[...new Set(duplicates)].join(", ")}`,
    );
  }
  const missing = ["organization_name", "domain", "source"].filter(
    (field) => !supported.includes(field as OrganizationImportField),
  );
  if (missing.length > 0) {
    throw new OrganizationImportFileError(
      "IMPORT_REQUIRED_COLUMNS_MISSING",
      "В файле отсутствуют обязательные колонки",
      Object.fromEntries(missing.map((field) => [field, "Добавьте колонку"])),
    );
  }
  const unknown = headers.filter((header) => header && !isImportField(header));
  if (unknown.length > 0) warnings.push(`Неизвестные колонки проигнорированы: ${unknown.join(", ")}`);
}

function validateValues(values: OrganizationImportValues) {
  const errors: Partial<Record<OrganizationImportField, string>> = {};
  if (!values.organization_name.trim()) errors.organization_name = "Укажите название организации";
  if (!values.domain.trim()) errors.domain = "Укажите домен";
  else if (!normalizeDomain(values.domain)) errors.domain = "Укажите корректный публичный домен";
  if (!values.source.trim()) errors.source = "Укажите источник";
  if (values.stage && !opportunityStageCatalog.some(({ code }) => code === values.stage)) {
    errors.stage = "Используйте код стадии S0–S10, SX или SL";
  }
  if (values.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contact_email)) {
    errors.contact_email = "Укажите корректный рабочий email";
  }
  if (
    !values.contact_name &&
    (values.contact_role || values.contact_email || values.contact_phone)
  ) {
    errors.contact_name = "Укажите контакт для заполненных контактных данных";
  }
  if (values.last_interaction_at && !isDate(values.last_interaction_at)) {
    errors.last_interaction_at = "Укажите дату в формате ISO или YYYY-MM-DD";
  }
  if (values.next_action && !values.next_action_due_at) {
    errors.next_action_due_at = "Укажите срок следующего действия";
  }
  if (!values.next_action && values.next_action_due_at) {
    errors.next_action = "Укажите следующее действие";
  }
  if (values.next_action_due_at && !isDate(values.next_action_due_at)) {
    errors.next_action_due_at = "Укажите дату в формате ISO или YYYY-MM-DD";
  }
  return errors;
}

function previewRow(input: {
  rowNo: number;
  values: OrganizationImportValues;
  normalizedDomain: string | null;
  fieldErrors: Partial<Record<OrganizationImportField, string>>;
  errorCode?: string | null;
  warnings?: string[];
  allowedDecisions?: OrganizationImportRow["allowedDecisions"];
}): OrganizationImportRow {
  return {
    rowNo: input.rowNo,
    values: input.values,
    normalizedDomain: input.normalizedDomain,
    decision: "conflict",
    resolvedDecision: null,
    allowedDecisions: input.allowedDecisions ?? [],
    matchedOrganization: null,
    fieldErrors: input.fieldErrors,
    warnings: input.warnings ?? [],
    errorCode: input.errorCode ?? null,
    entityId: null,
    appliedAt: null,
  };
}

function emptyValues(): OrganizationImportValues {
  return Object.fromEntries(organizationImportFields.map((field) => [field, ""])) as
    OrganizationImportValues;
}

function normalizeHeader(value: string) {
  return value.trim().toLocaleLowerCase("en-US").replace(/[\s-]+/g, "_");
}

function isImportField(value: string): value is OrganizationImportField {
  return (organizationImportFields as readonly string[]).includes(value);
}

function normalizeName(value: string) {
  return value.trim().toLocaleLowerCase("ru").replace(/\s+/g, " ");
}

function isDate(value: string) {
  return !Number.isNaN(new Date(value).getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
