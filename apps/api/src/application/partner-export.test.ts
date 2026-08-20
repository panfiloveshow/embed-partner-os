import { describe, expect, it } from "vitest";
import type { PartnerRegistryItem } from "@embed-os/contracts";
import {
  ExportAuthenticationRequiredError,
  ExportIdentityConfigurationError,
  buildPartnerCsv,
  resolveExportActor,
} from "./partner-export.js";

describe("partner export security boundary", () => {
  it("fails closed in production until the auth-proxy identity header is trusted", () => {
    expect(() =>
      resolveExportActor("oidc:user-1", {
        nodeEnv: "production",
        trustedIdentityHeader: "false",
      }),
    ).toThrow(ExportIdentityConfigurationError);
    expect(
      resolveExportActor("oidc:user-1", {
        nodeEnv: "production",
        trustedIdentityHeader: "true",
      }),
    ).toBe("oidc:user-1");
  });

  it("rejects missing and malformed actor subjects", () => {
    expect(() => resolveExportActor(undefined, { nodeEnv: "test" })).toThrow(
      ExportAuthenticationRequiredError,
    );
    expect(() => resolveExportActor("user\r\nx-admin: true", { nodeEnv: "test" })).toThrow(
      ExportAuthenticationRequiredError,
    );
  });

  it("neutralizes spreadsheet formulas in every exported text cell", () => {
    const csv = buildPartnerCsv([
      partner({
        name: '=HYPERLINK("https://evil.invalid")',
        legalName: " +SUM(1,1)",
        primaryDomain: "@malicious.invalid",
      }),
    ]);

    expect(csv).toContain('"\'=HYPERLINK(""https://evil.invalid"")"');
    expect(csv).toContain('"\' +SUM(1,1)"');
    expect(csv).toContain('"\'@malicious.invalid"');
  });
});

function partner(overrides: Partial<PartnerRegistryItem> = {}): PartnerRegistryItem {
  return {
    id: "org-1",
    version: 1,
    name: "Партнёр",
    legalName: null,
    segment: "Медиа",
    status: "ACTIVE",
    primaryDomain: "partner.example",
    domains: [{ id: "domain-1", host: "partner.example", isPrimary: true, verifiedAt: null }],
    organizationGroup: null,
    owner: { id: "user-1", name: "Анна" },
    currentStage: { code: "S4", label: "Диалог" },
    partnerScore: 80,
    integrationStatus: "not_started",
    lastActivityAt: null,
    nextAction: null,
    counts: { contacts: 1, opportunities: 1, tasks: 0, placements: 0, documents: 0 },
    ...overrides,
  };
}
