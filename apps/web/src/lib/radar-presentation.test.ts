import { describe, expect, it } from "vitest";
import { radarRejectReasonCodes } from "@embed-os/contracts";
import type { RadarCandidate } from "@embed-os/contracts";
import {
  inspectionPresentation,
  rejectReasonLabel,
  rejectReasonLabels,
} from "./radar-presentation";

type Evidence = RadarCandidate["evidence"][number];

describe("radar reject reason labels", () => {
  it("has a Russian label for every structured reason code", () => {
    for (const code of radarRejectReasonCodes) {
      expect(rejectReasonLabels[code]).toBeTruthy();
      expect(rejectReasonLabel(code)).toBe(rejectReasonLabels[code]);
    }
    expect(rejectReasonLabel(null)).toBeNull();
  });
});

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

  it("presents a detected competitor hosting as a migration opportunity", () => {
    const result = inspectionPresentation(
      evidence({
        status: "found",
        playerFound: true,
        playerType: "VK Видео",
        detectedPlayers: [
          { vendor: "vk", label: "VK Видео", competitor: true, via: "static", sampleUrl: null },
        ],
        competitorPlayerDetected: true,
      }),
    );

    expect(result).toMatchObject({ tone: "confirmed", noticeTone: "success" });
    expect(result.notice).toContain("VK Видео");
    expect(result.notice).toContain("сценарий миграции на RUTUBE-плеер");
  });

  it("never alarms when players were detected alongside a not_found status", () => {
    const result = inspectionPresentation(
      evidence({
        status: "not_found",
        errorCode: "VIDEO_PATTERN_NOT_FOUND",
        detectedPlayers: [
          { vendor: "videojs", label: "Video.js", competitor: false, via: "rendered" },
        ],
      }),
    );

    expect(result).toMatchObject({
      statusLabel: "Видео найдено",
      tone: "confirmed",
      noticeTone: "success",
    });
    expect(result.notice).toContain("Video.js");
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
