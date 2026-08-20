import type {
  PartnerCardPayload,
  PartnerExportAuditView,
  PartnerExportCommand,
  PartnerIntegrationStatus,
  PartnerRegistryPayload,
} from "@embed-os/contracts";
import type { PartnerExportResult } from "./application/partner-export.js";

export const PARTNER_PORT = Symbol("PARTNER_PORT");

export interface PartnerRegistryQuery extends PartnerExportCommand {
  integrationStatus?: PartnerIntegrationStatus;
}

export interface PartnerPort {
  listPartners(query?: PartnerRegistryQuery): PartnerRegistryPayload | Promise<PartnerRegistryPayload>;
  getPartner(organizationId: string): PartnerCardPayload | Promise<PartnerCardPayload>;
  exportPartners(query: PartnerRegistryQuery, actorSubject: string): Promise<PartnerExportResult>;
  listPartnerExportAudit(actorSubject: string): Promise<PartnerExportAuditView[]>;
}
