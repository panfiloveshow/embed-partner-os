import type {
  CommitOrganizationImportCommand,
  OrganizationImportJob,
} from "@embed-os/contracts";
import type { OrganizationImportFile } from "./application/organization-import.js";

export const ORGANIZATION_IMPORT_PORT = Symbol("ORGANIZATION_IMPORT_PORT");

export interface OrganizationImportPort {
  preview(file: OrganizationImportFile): Promise<OrganizationImportJob>;
  commit(
    jobId: string,
    input: CommitOrganizationImportCommand | unknown,
    idempotencyKey: string,
  ): Promise<OrganizationImportJob>;
  cancel(jobId: string, idempotencyKey: string): Promise<OrganizationImportJob>;
}
