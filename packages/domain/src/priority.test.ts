import { describe, expect, it } from "vitest";
import { calculatePriority } from "./priority.js";

describe("calculatePriority", () => {
  it("implements the explainable MVP formula", () => {
    const result = calculatePriority({
      overdueBusinessDays: 2,
      partnerScore: 85,
      hasInboundResponse: true,
      isIntegrationOrPilot: true,
      inactiveDays: 12,
    });

    expect(result.score).toBe(81);
    expect(result.reasons).toEqual([
      { code: "overdue", label: "Просрочка 2 дня" },
      { code: "inbound", label: "Ответ партнёра" },
      { code: "partner-potential", label: "Высокий потенциал" },
    ]);
  });

  it("adds the extended overdue penalty after three business days", () => {
    expect(calculatePriority({ overdueBusinessDays: 4 }).score).toBe(40);
  });

  it("reduces waiting work before its review date", () => {
    expect(
      calculatePriority({ partnerScore: 80, isWaitingBeforeReview: true }).score,
    ).toBe(0);
  });

  it("keeps the result in the inclusive 0..100 range", () => {
    expect(
      calculatePriority({
        overdueBusinessDays: 10,
        partnerScore: 100,
        hasInboundResponse: true,
        hasCriticalTechnicalAlert: true,
        inactiveDays: 100,
      }).score,
    ).toBe(100);
  });
});

