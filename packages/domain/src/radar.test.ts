import { describe, expect, it } from "vitest";
import type { RadarCandidateFeatures, RadarEvidence } from "@embed-os/contracts";
import {
  calculatePartnerScore,
  closestLprChannel,
  linkLprEmailsBySurname,
  normalizeRadarTarget,
  parseRadarDecisionCommand,
  parseRadarScoreAdjustmentCommand,
  transliterateRussian,
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

    // 92 = 100 minus the competitor-player feature (8): a RUTUBE embed is not
    // a competing hosting, so proven-demand points are not awarded.
    expect(score).toMatchObject({
      total: 92,
      automaticTotal: 92,
      priority: "high",
      modelVersion: "partner-score-v2",
    });
    expect(
      score.factors
        .filter(({ group }) => group === "business")
        .reduce((sum, factor) => sum + factor.value, 0),
    ).toBe(38);
    expect(score.factors.find(({ code }) => code === "player")).toMatchObject({
      value: 10,
      maxValue: 10,
    });
    expect(score.factors.find(({ code }) => code === "competitor-player")).toMatchObject({
      value: 0,
      maxValue: 8,
    });
  });

  it("awards proven-demand points when a competing video hosting is embedded", () => {
    const score = calculatePartnerScore({
      features,
      latestEvidence: {
        ...evidence,
        playerType: "VK Видео",
        detectedPlayers: [
          { vendor: "vk", label: "VK Видео", competitor: true, via: "static", sampleUrl: null },
          { vendor: "videojs", label: "Video.js", competitor: false, via: "rendered" },
        ],
        competitorPlayerDetected: true,
      },
      duplicateOrganization: false,
      duplicateCandidate: false,
      calculatedAt: new Date("2026-08-18T10:00:00.000Z"),
    });

    expect(score).toMatchObject({ total: 100, automaticTotal: 100, priority: "high" });
    const competitorFactor = score.factors.find(({ code }) => code === "competitor-player");
    expect(competitorFactor).toMatchObject({ value: 8, maxValue: 8 });
    expect(competitorFactor?.explanation).toContain("VK Видео");
    expect(score.factors.find(({ code }) => code === "player")?.explanation).toContain("Video.js");
    // The weight budget of the whole model stays within 100 points.
    expect(
      score.factors
        .filter(({ maxValue }) => maxValue > 0)
        .reduce((sum, factor) => sum + factor.maxValue, 0),
    ).toBe(100);
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

    // 79 positive - 55 automatic risks - 5 documented manual adjustment.
    expect(score.total).toBe(19);
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

  it("требует структурированную причину только при отклонении", () => {
    expect(() =>
      parseRadarDecisionCommand({ version: 1, decision: "reject", reason: "Не подходит" }),
    ).toThrow("Для отклонения нужна структурированная причина");
    expect(() =>
      parseRadarDecisionCommand({
        version: 1,
        decision: "reject",
        reason: "Не подходит",
        reasonCode: "spam",
      }),
    ).toThrow("Недопустимая причина отказа");
    expect(
      parseRadarDecisionCommand({
        version: 1,
        decision: "reject",
        reason: "Сайт давно не обновлялся",
        reasonCode: "dead_site",
      }),
    ).toMatchObject({ decision: "reject", reasonCode: "dead_site" });
    expect(
      parseRadarDecisionCommand({
        version: 1,
        decision: "defer",
        reason: "Позже",
        deferUntil: "2026-09-01T10:00:00.000Z",
        reasonCode: "low_traffic",
      }),
    ).toMatchObject({ decision: "defer", reasonCode: "low_traffic" });
    expect(
      parseRadarDecisionCommand({ version: 1, decision: "accept", reason: "Целевой контент" }),
    ).not.toHaveProperty("reasonCode");
  });

  it("отсеивает технические поддомены", () => {
    expect(() => normalizeRadarTarget("https://staging.media.example/story")).toThrow(
      "Технический поддомен исключён из Радара",
    );
  });
});

describe("closestLprChannel — ближайший канал к ЛПР без прямых контактов", () => {
  const director = {
    fullName: "Дубынин Дмитрий Геннадьевич",
    role: "ГЕНЕРАЛЬНЫЙ ДИРЕКТОР",
    department: "Руководство",
    email: null,
    phone: null,
    profileUrl: null,
    sourceUrl: "https://egrul.nalog.ru/",
    evidence: "ЕГРЮЛ: ГЕНЕРАЛЬНЫЙ ДИРЕКТОР: Дубынин Дмитрий Геннадьевич",
    confidence: "high" as const,
  };
  const email = (localPart: string) => ({
    type: "email" as const,
    value: `${localPart}@lenta-co.ru`,
    href: `mailto:${localPart}@lenta-co.ru`,
    sourceUrl: "https://lenta.ru/contacts",
    confidence: "high" as const,
  });

  it("руководству предлагает общий ящик организации", () => {
    const link = closestLprChannel(director, [
      email("it"),
      email("info"),
      email("pr"),
    ]);
    expect(link?.contactValue).toBe("info@lenta-co.ru");
    expect(link?.rationale).toContain("руководству");
    expect(link?.confidence).toBe("high");
  });

  it("коммерческому отделу — коммерческий ящик, а не технический", () => {
    const link = closestLprChannel(
      { ...director, role: "КОММЕРЧЕСКИЙ ДИРЕКТОР", department: "Коммерческий отдел" },
      [email("it"), email("partners")],
    );
    expect(link?.contactValue).toBe("partners@lenta-co.ru");
  });

  it("если профильного ящика нет — берёт первый публичный как точку входа", () => {
    const link = closestLprChannel(director, [email("support")]);
    expect(link?.contactValue).toBe("support@lenta-co.ru");
    expect(link?.rationale).toContain("точка входа");
  });

  it("без email — телефон, затем страница контактов", () => {
    const phone = {
      type: "phone" as const,
      value: "+7 495 785-17-00",
      href: "tel:+74957851700",
      sourceUrl: "https://lenta.ru/contacts",
      confidence: "high" as const,
    };
    expect(closestLprChannel(director, [phone])?.contactType).toBe("phone");
    const page = {
      type: "contact_page" as const,
      value: "Контакты",
      href: "https://lenta.ru/contacts",
      sourceUrl: "https://lenta.ru/",
      confidence: "medium" as const,
    };
    expect(closestLprChannel(director, [page])?.contactType).toBe("contact_page");
  });

  it("у ЛПР с прямым email связь уже есть -> null", () => {
    expect(
      closestLprChannel({ ...director, email: "dubinin@lenta-co.ru" }, [email("info")]),
    ).toBeNull();
  });
});

describe("linkLprEmailsBySurname — кросс-страничная связка фамилия ↔ email", () => {
  const person = {
    fullName: "Соколов Артём Викторович",
    role: "Заместитель генерального директора",
    department: "Руководство",
    email: null,
    phone: null,
    profileUrl: null,
    sourceUrl: "https://media.example.ru/team",
    evidence: "Блок команды: Соколов Артём Викторович, заместитель генерального директора",
    confidence: "medium" as const,
  };
  const email = (localPart: string) => ({
    type: "email" as const,
    value: `${localPart}@media.example.ru`,
    href: `mailto:${localPart}@media.example.ru`,
    sourceUrl: "https://media.example.ru/contacts",
    confidence: "high" as const,
  });

  it("транслитерирует русскую фамилию (Соколов -> sokolov)", () => {
    expect(transliterateRussian("Соколов")).toBe("sokolov");
  });

  it("прикрепляет email, чья локальная часть начинается с фамилии", () => {
    const [linked] = linkLprEmailsBySurname([person], [
      email("info"),
      email("sokolov"),
      email("support"),
    ]);
    expect(linked?.email).toBe("sokolov@media.example.ru");
    expect(linked?.confidence).toBe("medium");
    expect(linked?.evidence).toContain("по фамилии");
  });

  it("прямой email не перезаписывается", () => {
    const [linked] = linkLprEmailsBySurname([{ ...person, email: "a.sokolov@media.example.ru" }], [
      email("sokolov"),
    ]);
    expect(linked?.email).toBe("a.sokolov@media.example.ru");
  });

  it("без совпадений и без email — человек остаётся как был", () => {
    const [linked] = linkLprEmailsBySurname([person], [email("press")]);
    expect(linked?.email).toBeNull();
    expect(linked?.evidence).toBe(person.evidence);
  });
});
