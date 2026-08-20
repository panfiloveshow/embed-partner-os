import { describe, expect, it } from "vitest";
import { DomainRuleError } from "./task-completion.js";
import {
  parseChangeContactStatusCommand,
  parseCreateContactCommand,
  parseLinkContactCommand,
  parseMergeContactCommand,
  parseUpdateContactCommand,
} from "./contact.js";

describe("parseCreateContactCommand", () => {
  it("normalizes channels and trims profile fields", () => {
    expect(
      parseCreateContactCommand({
        fullName: "  Мария Орлова  ",
        role: " Редактор ",
        department: " Контент ",
        email: " MARIA@EXAMPLE.RU ",
        phone: "8 (999) 123-45-67",
        messenger: " Maria_Orlova ",
        source: " Конференция ",
        verifiedAt: "2026-08-18T12:00:00+03:00",
        restrictions: " Только рабочее время ",
      }),
    ).toEqual({
      fullName: "Мария Орлова",
      role: "Редактор",
      department: "Контент",
      email: "maria@example.ru",
      phone: "+79991234567",
      messenger: "@maria_orlova",
      source: "Конференция",
      verifiedAt: "2026-08-18T09:00:00.000Z",
      restrictions: "Только рабочее время",
    });
  });

  it("requires at least one working channel", () => {
    expect(() =>
      parseCreateContactCommand({ fullName: "Мария Орлова", role: "Редактор" }),
    ).toThrowError(DomainRuleError);
  });

  it("rejects an invalid email", () => {
    expect(() =>
      parseCreateContactCommand({
        fullName: "Мария Орлова",
        role: "Редактор",
        email: "not-an-email",
      }),
    ).toThrowError(/email/i);
  });
});

describe("parseUpdateContactCommand", () => {
  it("normalizes profile, freshness and one organization role", () => {
    expect(parseUpdateContactCommand({
      version: 2,
      fullName: " Мария Орлова ",
      email: " MARIA@EXAMPLE.RU ",
      source: " Встреча ",
      verifiedAt: "2026-08-18T12:00:00+03:00",
      restrictions: " Без звонков ",
      organizationLink: { id: " link-1 ", role: " Редактор ", department: " Контент " },
    })).toEqual({
      version: 2,
      fullName: "Мария Орлова",
      email: "maria@example.ru",
      source: "Встреча",
      verifiedAt: "2026-08-18T09:00:00.000Z",
      restrictions: "Без звонков",
      organizationLink: { id: "link-1", role: "Редактор", department: "Контент" },
    });
  });

  it("rejects a stale-shaped command without a positive version", () => {
    expect(() => parseUpdateContactCommand({
      version: 0,
      fullName: "Мария Орлова",
      email: "maria@example.ru",
      source: "Встреча",
    })).toThrowError(DomainRuleError);
  });
});

describe("parseChangeContactStatusCommand", () => {
  it("requires a positive version and an explicit reason", () => {
    expect(parseChangeContactStatusCommand({ version: 3, reason: " Контакт устарел " }))
      .toEqual({ version: 3, reason: "Контакт устарел" });
    expect(() => parseChangeContactStatusCommand({ version: 3, reason: "" }))
      .toThrowError(DomainRuleError);
  });
});

describe("parseLinkContactCommand", () => {
  it("normalizes the organization-specific role", () => {
    expect(
      parseLinkContactCommand({ role: " Технический эксперт ", department: " ИТ " }),
    ).toEqual({ role: "Технический эксперт", department: "ИТ" });
  });

  it("requires a role for the organization link", () => {
    expect(() => parseLinkContactCommand({ department: "ИТ" })).toThrowError(
      DomainRuleError,
    );
  });
});

describe("parseMergeContactCommand", () => {
  it("normalizes the target and mandatory reason", () => {
    expect(
      parseMergeContactCommand({
        targetContactId: " contact-target ",
        reason: " Совпадает рабочий email ",
      }),
    ).toEqual({
      targetContactId: "contact-target",
      reason: "Совпадает рабочий email",
    });
  });

  it("requires an explicit merge reason", () => {
    expect(() =>
      parseMergeContactCommand({ targetContactId: "contact-target" }),
    ).toThrowError(DomainRuleError);
  });
});
