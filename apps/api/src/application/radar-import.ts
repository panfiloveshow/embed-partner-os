import type { CreateRadarCandidateCommand } from "@embed-os/contracts";
import { parseOrganizationImportFile, type OrganizationImportFile } from "./organization-import.js";

export async function parseRadarImportFile(file: OrganizationImportFile) {
  const parsed = await parseOrganizationImportFile(file);
  return {
    fileName: file.fileName,
    format: parsed.format,
    warnings: parsed.warnings,
    rows: parsed.rows.map(({ rowNo, values }) => ({
      rowNo,
      command: {
        name: values.organization_name,
        url: values.domain,
        source: values.source,
        ...(values.segment ? { topic: values.segment } : {}),
        contactsFound: Boolean(values.contact_name || values.contact_email || values.contact_phone),
      } satisfies CreateRadarCandidateCommand,
    })),
  };
}
