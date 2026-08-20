import { describe, expect, it } from "vitest";
import type { RadarCandidateFeatures, RadarEvidence } from "@embed-os/contracts";
import {
  calculatePartnerScore,
  normalizeRadarTarget,
  parseRadarDecisionCommand,
  parseRadarScoreAdjustmentCommand,
} from "./radar.js";

const features: RadarCandidateFeatures = {
  topic: "Новости",
  language: "ru",
  geography: "Россия",
  publicationFrequency: "daily",
  contactsFound: true,
  cms: "WordPress",
  estimatedVideoPagesMin: 80,
  estimatedVideoPagesMax: 120,
  trafficEstimate: {
    provider: "Тестовый провайдер",
    measuredAt: "2026-08-18T00:00:00.000Z",
    minMonthlyVisits: 250_000,
    maxMonthlyVisits: 1_200_000,
    confidence: "medium",
  },
};

const evidence: RadarEvidence = {
  id: "evidence-1",
  pageUrl: "https://media.example/video",
  status: "found",
  playerType: "RUTUBE",
  detectedAt: "2026-08-18T10:00:00.000Z",
  method: "l0-html",
  confidence: "high",
  httpStatus: 200,
  playerFound: true,
  embedUrl: "https://rutube.ru/play/embed/123/",
  errorCode: null,
};

describe("radar domain", () => {
  it("calculates an explainable high-priority score within group caps", () => {
    const score = calculatePartnerScore({
      features,
      latestEvidence: evidence,
      duplicateOrganization: false,
      duplicateCandidate: false,
      calculatedAt: new Date("2026-08-18T10:00:00.000Z"),
    });

    expect(score).toMatchObject({ total: 100, automaticTotal: 100, priority: "high" });
    expect(
      score.factors
        .filter(({ group }) => group === "business")
        .reduce((sum, factor) => sum + factor.value, 0),
    ).toBe(40);
    expect(score.factors.find(({ code }) => code === "player")).toMatchObject({
      value: 14,
      maxValue: 14,
    });
  });

  it("separates duplicate and confidence risks from the positive score", () => {
    const score = calculatePartnerScore({
      features: {
        ...features,
        trafficEstimate: { ...features.trafficEstimate!, confidence: "low" },
      },
      latestEvidence: { ...evidence, status: "blocked", playerFound: false, playerType: null },
      duplicateOrganization: true,
      duplicateCandidate: false,
      manualAdjustment: -5,
      manualAdjustmentComment: "Ручная проверка риска",
      calculatedAt: new Date("2026-08-18T10:00:00.000Z"),
    });

    // 83 positive - 55 automatic risks - 5 documented manual adjustment.
    expect(score.total).toBe(23);
    expect(score.priority).toBe("low");
    expect(score.factors.filter(({ group }) => group === "risk").map(({ value }) => value)).toEqual(
      [-40, -10, -5],
    );
  });

  it("normalizes a URL and validates decision-specific fields", () => {
    expect(normalizeRadarTarget("HTTPS://WWW.Example.RU/video#player")).toEqual({
      pageUrl: "https://example.ru/video",
      hostNormalized: "example.ru",
    });
    expect(() =>
      parseRadarDecisionCommand({ version: 1, decision: "defer", reason: "Позже" }),
    ).toThrow();
    expect(() =>
      parseRadarScoreAdjustmentCommand({ version: 1, adjustment: 5, comment: "" }),
    ).toThrow();
  });

  it("отсеивает технические поддомены", () => {
    expect(() => normalizeRadarTarget("https://staging.media.example/story")).toThrow(
      "Технический поддомен исключён из Радара",
    );
  });
});
