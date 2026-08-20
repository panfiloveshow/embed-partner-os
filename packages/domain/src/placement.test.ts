import { describe, expect, it } from "vitest";
import { DomainRuleError } from "./task-completion.js";
import {
  parseArchivePlacementCommand,
  parseRegisterPlacementCommand,
  parseUpdatePlacementCommand,
} from "./placement.js";

describe("placement registration", () => {
  it("normalizes a public page URL and defaults the URL pattern", () => {
    expect(
      parseRegisterPlacementCommand({
        organizationId: " org-1 ",
        opportunityId: " opp-1 ",
        pageUrl: " HTTPS://Partner.Example:443/articles/video#player ",
        embedType: "video",
        environment: "production",
        businessStatus: "planned",
      }),
    ).toEqual({
      organizationId: "org-1",
      opportunityId: "opp-1",
      pageUrl: "https://partner.example/articles/video",
      urlPattern: "https://partner.example/articles/video",
      embedType: "video",
      environment: "production",
      businessStatus: "planned",
    });
  });

  it("requires a timezone-aware launch date for an active placement", () => {
    expect(() =>
      parseRegisterPlacementCommand({
        organizationId: "org-1",
        opportunityId: "opp-1",
        pageUrl: "https://partner.example/video",
        embedType: "video",
        environment: "production",
        businessStatus: "active",
      }),
    ).toThrowError(DomainRuleError);
  });

  it("rejects credentials and non-HTTP placement URLs", () => {
    for (const pageUrl of ["file:///etc/passwd", "https://user:secret@partner.example/video"]) {
      expect(() =>
        parseRegisterPlacementCommand({
          organizationId: "org-1",
          opportunityId: "opp-1",
          pageUrl,
          embedType: "video",
          environment: "production",
          businessStatus: "planned",
        }),
      ).toThrowError(DomainRuleError);
    }
  });
});

describe("placement lifecycle commands", () => {
  it("normalizes mutable placement fields and preserves an explicit launch-date reset", () => {
    expect(
      parseUpdatePlacementCommand({
        version: 7,
        pageUrl: " HTTPS://Partner.Example:443/new#player ",
        urlPattern: " /new/* ",
        embedType: "live",
        environment: "staging",
        businessStatus: "paused",
        launchedAt: null,
        reason: " Временная остановка партнёром ",
      }),
    ).toEqual({
      version: 7,
      pageUrl: "https://partner.example/new",
      urlPattern: "/new/*",
      embedType: "live",
      environment: "staging",
      businessStatus: "paused",
      launchedAt: null,
      reason: "Временная остановка партнёром",
    });
  });

  it("requires a positive version, a reason and at least one changed field", () => {
    for (const input of [
      { version: 0, businessStatus: "paused", reason: "Пауза" },
      { version: 1, businessStatus: "paused", reason: "" },
      { version: 1, reason: "Без изменений" },
    ]) {
      expect(() => parseUpdatePlacementCommand(input)).toThrowError(DomainRuleError);
    }
  });

  it("parses an archive command with optimistic version and explicit reason", () => {
    expect(parseArchivePlacementCommand({ version: 3, reason: " Договор завершён " })).toEqual({
      version: 3,
      reason: "Договор завершён",
    });
  });
});
