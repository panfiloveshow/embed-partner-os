import { createHash } from "node:crypto";
import type {
  PartnerExportAuditView,
  PartnerExportCommand,
  PartnerIntegrationStatus,
  PartnerRegistryItem,
} from "@embed-os/contracts";

export const PARTNER_EXPORT_PERMISSION = "partners.export" as const;

export class ExportAuthenticationRequiredError extends Error {
  readonly code = "EXPORT_AUTHENTICATION_REQUIRED";
  constructor() {
    super("Для экспорта требуется подтверждённая корпоративная учётная запись");
    this.name = "ExportAuthenticationRequiredError";
  }
}

export class ExportPermissionDeniedError extends Error {
  readonly code = "EXPORT_PERMISSION_DENIED";
  constructor() {
    super("Для учётной записи не выдано отдельное разрешение на экспорт");
    this.name = "ExportPermissionDeniedError";
  }
}

export class ExportIdentityConfigurationError extends Error {
  readonly code = "EXPORT_IDENTITY_NOT_CONFIGURED";
  constructor() {
    super("В production не настроен доверенный identity-заголовок auth-proxy");
    this.name = "ExportIdentityConfigurationError";
  }
}

export interface PartnerExportResult {
  audit: PartnerExportAuditView;
  content: string;
  contentType: "text/csv; charset=utf-8";
}

export function resolveExportActor(
  rawSubject: string | undefined,
  config: { nodeEnv?: string; trustedIdentityHeader?: string; authMode?: string } = {},
) {
  const nodeEnv = config.nodeEnv ?? process.env.NODE_ENV;
  const authMode = config.authMode ?? process.env.AUTH_MODE;
  const trustedIdentityHeader = config.trustedIdentityHeader
    ?? process.env.TRUSTED_IDENTITY_HEADER;
  if (
    nodeEnv === "production" &&
    authMode !== "oidc_jwt" &&
    trustedIdentityHeader !== "true"
  ) {
    throw new ExportIdentityConfigurationError();
  }
  const subject = rawSubject?.trim();
  if (
    !subject ||
    subject.length > 200 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:._@/-]*$/.test(subject)
  ) {
    throw new ExportAuthenticationRequiredError();
  }
  return subject;
}

export function createPartnerExport(
  partners: PartnerRegistryItem[],
  filters: PartnerExportCommand,
  actorSubject: string,
  auditId: string,
  generatedAt: Date,
): PartnerExportResult {
  const content = buildPartnerCsv(partners);
  const date = generatedAt.toISOString().slice(0, 10);
  const fileName = `rutube-partners-${date}.csv`;
  return {
    content,
    contentType: "text/csv; charset=utf-8",
    audit: {
      id: auditId,
      actorSubject,
      permission: PARTNER_EXPORT_PERMISSION,
      generatedAt: generatedAt.toISOString(),
      rowCount: partners.length,
      fileName,
      checksum: createHash("sha256").update(content, "utf8").digest("hex"),
      filters: structuredClone(filters),
    },
  };
}

export function buildPartnerCsv(partners: PartnerRegistryItem[]) {
  const header = [
    "organization_id",
    "name",
    "legal_name",
    "organization_group",
    "primary_domain",
    "domains",
    "segment",
    "owner",
    "stage",
    "partner_score",
    "integration_status",
    "last_activity_at",
  ];
  const rows = partners.map((partner) => [
    partner.id,
    partner.name,
    partner.legalName,
    partner.organizationGroup?.name,
    partner.primaryDomain,
    partner.domains.map(({ host }) => host).join(" | "),
    partner.segment,
    partner.owner?.name,
    partner.currentStage?.label,
    partner.partnerScore,
    integrationLabel(partner.integrationStatus),
    partner.lastActivityAt,
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

function csvCell(value: string | number | null | undefined) {
  let normalized = value === null || value === undefined ? "" : String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replaceAll('"', '""')}"`;
}

function integrationLabel(status: PartnerIntegrationStatus) {
  return ({
    not_started: "Не начата",
    planned: "Планируется",
    active: "Активна",
    issue: "Проблема",
  } as const)[status];
}
