import { describe, expect, it } from "vitest";
import type { RadarCandidate } from "@embed-os/contracts";
import { inspectionPresentation } from "./radar-presentation";

type Evidence = RadarCandidate["evidence"][number];

describe("radar inspection presentation", () => {
  it("does not present a network failure as a successful verification", () => {
    const result = inspectionPresentation(
      evidence({ status: "unknown", errorCode: "NETWORK_ERROR" }),
    );

    expect(result).toMatchObject({
      statusLabel: "Не проверен",
      tone: "warning",
      noticeTone: "warning",
    });
    expect(result.notice).toContain("нет сетевого доступа");
  });

  it("distinguishes an accessible page without a player", () => {
    const result = inspectionPresentation(
      evidence({ status: "not_found", errorCode: "VIDEO_PATTERN_NOT_FOUND" }),
    );

    expect(result).toMatchObject({
      statusLabel: "Плеер не найден",
      tone: "neutral",
      noticeTone: "warning",
    });
  });

  it("uses success only when a player is confirmed", () => {
    const result = inspectionPresentation(
      evidence({
        status: "found",
        errorCode: null,
        playerFound: true,
        playerType: "RUTUBE",
      }),
    );

    expect(result).toMatchObject({
      statusLabel: "Плеер найден",
      tone: "confirmed",
      noticeTone: "success",
    });
  });
});

function evidence(overrides: Partial<Evidence>): Evidence {
  return {
    id: "evidence-1",
    pageUrl: "https://example.ru/",
    status: "unknown",
    playerType: null,
    detectedAt: "2026-08-19T10:21:20.908Z",
    method: "l0-html",
    confidence: "low",
    httpStatus: null,
    playerFound: false,
    embedUrl: null,
    errorCode: null,
    ...overrides,
  };
}
