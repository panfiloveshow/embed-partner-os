import { describe, expect, it } from "vitest";
import type { RadarPayload } from "@embed-os/contracts";
import {
  formatSenderSignature,
  parseSenderProfileInput,
  withSenderProfile,
} from "./sender-profile.js";

describe("parseSenderProfileInput", () => {
  it("принимает корректный профиль и чистит пробелы/@", () => {
    const parsed = parseSenderProfileInput({
      fullName: "  Анна Соколова ",
      email: "A.Sokolova@rutube.ru ",
      telegram: "@asokolova",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { fullName: "Анна Соколова", email: "A.Sokolova@rutube.ru", telegram: "asokolova" },
    });
  });

  it("пустые строки = очистка полей", () => {
    const parsed = parseSenderProfileInput({ fullName: "", email: "", telegram: "" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ fullName: null, email: null, telegram: null });
    }
  });

  it("отклоняет битый email и плохой хэндл Telegram", () => {
    expect(parseSenderProfileInput({ email: "не-почта" }).ok).toBe(false);
    expect(parseSenderProfileInput({ telegram: "a" }).ok).toBe(false);
    expect(parseSenderProfileInput({ telegram: "плохой хэндл!" }).ok).toBe(false);
    expect(parseSenderProfileInput("строка").ok).toBe(false);
  });
});

describe("formatSenderSignature", () => {
  it("собирает подпись из заполненных полей", () => {
    const signature = formatSenderSignature({
      fullName: "Анна Соколова",
      email: "a@rutube.ru",
      telegram: "asokolova",
    });
    expect(signature).toContain("С уважением,");
    expect(signature).toContain("Анна Соколова");
    expect(signature).toContain("a@rutube.ru · @asokolova");
  });

  it("пустой профиль — пустая подпись", () => {
    expect(formatSenderSignature(null)).toBe("");
    expect(formatSenderSignature({ fullName: null, email: null, telegram: null })).toBe("");
  });
});

describe("withSenderProfile", () => {
  const payload: RadarPayload = {
    generatedAt: "2026-08-25T12:00:00Z",
    total: 1,
    trafficProvider: { configured: false, provider: null },
    candidates: [
      {
        id: "c1",
        name: "Пример",
        source: "manual",
        inputUrl: "https://example.ru",
        pageUrl: "https://example.ru/",
        hostNormalized: "example.ru",
        status: "ready",
        duplicateOrganization: null,
        duplicateCandidate: null,
        inspectionPending: false,
        features: {},
        research: {
          method: "html-signals-v1",
          pageUrl: "https://example.ru/",
          collectedAt: "2026-08-25T12:00:00Z",
          signals: [],
          contacts: [],
          decisionMakers: [],
          videoPages: [],
          notes: [],
          brief: {
            readiness: "ready_for_outreach",
            siteSummary: "",
            videoUsage: "",
            rutubeUseCase: "",
            likelyContactRoles: [],
            risks: [],
            nextAction: "",
            outreach: {
              targetName: null,
              targetRole: "Коммерческий отдел",
              channel: "email",
              destination: "hi@example.ru",
              subject: "Тема",
              messageDraft: "Здравствуйте! Черновик письма.",
              discoveryQuestions: [],
              nextTask: "",
            },
          },
        },
        evidence: [],
        decisions: [],
        score: {
          total: 0,
          automaticTotal: 0,
          manualAdjustment: 0,
          manualAdjustmentComment: null,
          priority: "low",
          modelVersion: "partner-score-v2",
          factors: [],
          calculatedAt: "2026-08-25T12:00:00Z",
        },
        version: 1,
        createdAt: "2026-08-25T12:00:00Z",
        updatedAt: "2026-08-25T12:00:00Z",
      },
    ],
  };

  it("дописывает подпись в черновик и заполняет sender", () => {
    const profile = { fullName: "Анна Соколова", email: "a@rutube.ru", telegram: null };
    const result = withSenderProfile(payload, profile);
    const outreach = result.candidates[0]?.research?.brief.outreach;
    expect(outreach?.sender).toEqual(profile);
    expect(outreach?.messageDraft).toContain("Здравствуйте! Черновик письма.");
    expect(outreach?.messageDraft).toContain("Анна Соколова");
    // Исходный payload не мутируется.
    expect(payload.candidates[0]?.research?.brief.outreach?.messageDraft).not.toContain(
      "Анна Соколова",
    );
  });

  it("повторная выдача не дублирует подпись", () => {
    const profile = { fullName: "Анна Соколова", email: null, telegram: null };
    const once = withSenderProfile(payload, profile);
    const twice = withSenderProfile(once, profile);
    const draft = twice.candidates[0]?.research?.brief.outreach?.messageDraft ?? "";
    expect(draft.split("С уважением,").length - 1).toBeLessThanOrEqual(1);
  });

  it("кандидат без досье остаётся без изменений", () => {
    const empty: RadarPayload = {
      ...payload,
      candidates: [{ ...payload.candidates[0]!, research: null }],
    };
    const result = withSenderProfile(empty, { fullName: "X", email: null, telegram: null });
    expect(result.candidates[0]?.research).toBeNull();
  });
});
