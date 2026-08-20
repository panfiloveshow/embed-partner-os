import { describe, expect, it } from "vitest";
import { DomainRuleError } from "./task-completion.js";
import {
  assertOpportunityStageReady,
  assertOpportunityTransitionAllowed,
  parseTransitionOpportunityStageCommand,
} from "./opportunity-stage.js";

describe("opportunity stage transitions", () => {
  it("parses a pause with an explicit review date", () => {
    expect(parseTransitionOpportunityStageCommand({
      version: 4,
      toStageCode: "SX",
      reason: " Партнёр заморозил проект ",
      pauseReason: " Нет ресурса на интеграцию ",
      reviewAt: "2026-09-01T10:00:00+03:00",
    })).toEqual({
      version: 4,
      toStageCode: "SX",
      reason: "Партнёр заморозил проект",
      pauseReason: "Нет ресурса на интеграцию",
      reviewAt: "2026-09-01T07:00:00.000Z",
    });
  });

  it("requires complete close data and either a return date or never-return flag", () => {
    expect(() => parseTransitionOpportunityStageCommand({
      version: 2,
      toStageCode: "SL",
      reason: "Закрытие",
      closeReason: "Нет приоритета",
      closeComment: "Партнёр отказался от проекта",
    })).toThrowError(DomainRuleError);

    expect(parseTransitionOpportunityStageCommand({
      version: 2,
      toStageCode: "SL",
      reason: "Закрытие после отказа",
      closeReason: "Нет приоритета",
      closeComment: "Партнёр отказался от проекта",
      neverReturn: true,
    })).toMatchObject({ toStageCode: "SL", neverReturn: true });
  });

  it("allows only the next working stage, pause, close, or the recorded resume stage", () => {
    expect(() => assertOpportunityTransitionAllowed("S7", "S8", null)).not.toThrow();
    expect(() => assertOpportunityTransitionAllowed("S7", "SX", null)).not.toThrow();
    expect(() => assertOpportunityTransitionAllowed("S7", "S9", null)).toThrowError(DomainRuleError);
    expect(() => assertOpportunityTransitionAllowed("SX", "S7", "S7")).not.toThrow();
    expect(() => assertOpportunityTransitionAllowed("SX", "S6", "S7")).toThrowError(DomainRuleError);
  });

  it("normalizes stage-specific data in the transition command", () => {
    expect(parseTransitionOpportunityStageCommand({
      version: 1,
      toStageCode: "S8",
      reason: "Пилот готов",
      stageData: {
        pilotStartsAt: "2026-08-20T10:00:00+03:00",
        pilotEndsAt: "2026-09-03T10:00:00+03:00",
        successCriteria: "  99% успешных проверок  ",
        pilotReviewAt: "2026-08-27T10:00:00+03:00",
        metricsSource: " RUTUBE Analytics ",
      },
    })).toMatchObject({
      stageData: {
        pilotStartsAt: "2026-08-20T07:00:00.000Z",
        pilotEndsAt: "2026-09-03T07:00:00.000Z",
        successCriteria: "99% успешных проверок",
        pilotReviewAt: "2026-08-27T07:00:00.000Z",
        metricsSource: "RUTUBE Analytics",
      },
    });
  });

  it("returns the exact missing-field list for a researched opportunity", () => {
    try {
      assertOpportunityStageReady("S1", {}, {
        primaryDomain: null,
        topic: null,
        score: null,
        ownerId: null,
        hasNextAction: false,
        hasContactOrChannel: false,
        latestInteraction: null,
        hasActivePlacement: false,
        hasLaunchedPlacement: false,
        hasHealthyMonitoredPlacement: false,
        hasPlacementOwner: false,
      });
      throw new Error("Expected BR-003");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainRuleError);
      expect((error as DomainRuleError).code).toBe("BR-003");
      expect((error as DomainRuleError).fieldErrors).toEqual({
        primaryDomain: "Укажите основной домен организации",
        topic: "Укажите тематику организации",
        "stageData.geography": "Заполните поле «География»",
        "stageData.videoPlayerType": "Заполните поле «Тип видеоплеера»",
        "stageData.dataSource": "Заполните поле «Источник данных»",
        "stageData.researchCheckedAt": "Заполните поле «Дата проверки»",
      });
    }
  });

  it("accepts complete integration and pilot field sets", () => {
    const facts = {
      primaryDomain: "partner.ru",
      topic: "Новости",
      score: 80,
      ownerId: "user-1",
      hasNextAction: true,
      hasContactOrChannel: true,
      latestInteraction: {
        occurredAt: "2026-08-18T10:00:00.000Z",
        type: "email",
        outcome: "Ответ получен",
      },
      hasActivePlacement: false,
      hasLaunchedPlacement: false,
      hasHealthyMonitoredPlacement: false,
      hasPlacementOwner: false,
    };
    expect(() => assertOpportunityStageReady("S7", {
      testUrl: "https://partner.ru/test",
      technicalContact: "Иван Петров",
      embedType: "video",
      integrationChecklist: ["iframe добавлен", "CSP проверен"],
      launchDueAt: "2026-08-25T10:00:00.000Z",
    }, facts)).not.toThrow();
    expect(() => assertOpportunityStageReady("S8", {
      pilotStartsAt: "2026-08-25T10:00:00.000Z",
      pilotEndsAt: "2026-09-08T10:00:00.000Z",
      successCriteria: "Плеер доступен на 99% проверок",
      pilotReviewAt: "2026-09-01T10:00:00.000Z",
      metricsSource: "RUTUBE Analytics",
    }, facts)).not.toThrow();
  });
});
