import { describe, expect, it } from "vitest";
import type { RadarInspectionObservation } from "./monitoring/radar-page-inspector.js";
import { RadarCandidateVersionConflictError, RadarService } from "./radar.service.js";
import { TodayService } from "./today.service.js";

describe("RadarService", () => {
  it("импортирует CSV построчно и исключает дубли с техническими хостами", async () => {
    const service = new RadarService(new TodayService(), new FoundInspector(), fixedClock);
    const file = {
      fileName: "radar.csv",
      buffer: Buffer.from(
        [
          "organization_name,domain,source,segment",
          "Новый сайт,new-radar.example,Каталог,Новости",
          "Дубль,new-radar.example,Каталог,Новости",
          "Тест,staging.media.example,Каталог,Новости",
        ].join("\n"),
      ),
    };

    const result = await service.import(file, "radar-import-key-0001");
    const replay = await service.import(file, "radar-import-key-0001");

    expect(replay).toEqual(result);
    expect(result).toMatchObject({
      format: "csv",
      total: 3,
      created: 1,
      skipped: 1,
      failed: 1,
    });
    expect(result.rows.map(({ status }) => status)).toEqual(["created", "skipped", "failed"]);
  });

  it("создаёт, проверяет и откладывает кандидата с историей решений", async () => {
    const service = new RadarService(new TodayService(), new FoundInspector(), fixedClock);
    const created = service.create(candidateCommand(), "radar-create-key-0001");
    const replay = service.create(candidateCommand(), "radar-create-key-0001");

    expect(replay).toEqual(created);
    expect(created).toMatchObject({
      status: "new",
      hostNormalized: "new-media.example",
      version: 1,
      evidence: [],
      decisions: [],
    });

    const inspected = await service.inspect(created.id, "radar-check-key-0001");
    expect(inspected).toMatchObject({
      status: "ready",
      version: 2,
      evidence: [{ status: "found", playerType: "RUTUBE", confidence: "high" }],
    });
    expect(inspected.score.factors.find(({ code }) => code === "player")).toMatchObject({
      value: 10,
    });

    const adjusted = service.adjustScore(
      created.id,
      {
        version: 2,
        adjustment: -7,
        comment: "Низкая доля видео на главной",
      },
      "radar-score-key-0001",
    );
    expect(adjusted.score).toMatchObject({
      manualAdjustment: -7,
      manualAdjustmentComment: "Низкая доля видео на главной",
    });

    const deferred = service.decide(
      created.id,
      {
        version: 3,
        decision: "defer",
        reason: "Повторная оценка после медиакита",
        deferUntil: "2026-08-25T10:00:00.000Z",
      },
      "radar-decision-key-0001",
    );
    expect(deferred).toMatchObject({
      status: "deferred",
      deferUntil: "2026-08-25T10:00:00.000Z",
      version: 4,
      decisions: [{ decision: "defer", reason: "Повторная оценка после медиакита" }],
    });
  });

  it("принятие создаёт организацию, возможность и первую задачу", async () => {
    const today = new TodayService();
    const service = new RadarService(today, new FoundInspector(), fixedClock);
    const created = service.create(candidateCommand(), "radar-create-key-0010");
    const inspected = await service.inspect(created.id, "radar-check-key-0010");

    const accepted = service.decide(
      created.id,
      {
        version: inspected.version,
        decision: "accept",
        reason: "Целевой охват и найден RUTUBE",
        comment: "Передать в работу Анне",
      },
      "radar-decision-key-0010",
    );

    expect(accepted).toMatchObject({
      status: "accepted",
      acceptedOrganizationId: expect.stringMatching(/^org-/),
      acceptedOpportunityId: expect.stringMatching(/^opp-/),
      decisions: [{ decision: "accept", reason: "Целевой охват и найден RUTUBE" }],
    });
    expect(today.getToday().actions).toHaveLength(17);
    expect(
      today
        .getToday()
        .actions.find(({ organizationId }) => organizationId === accepted.acceptedOrganizationId),
    ).toMatchObject({
      opportunityId: accepted.acceptedOpportunityId,
      organizationName: "Новые медиа",
      domain: "new-media.example",
      stageCode: "S2",
      stageLabel: "Квалифицирован",
      title: expect.stringContaining("editor@new-media.example"),
      contacts: [
        expect.objectContaining({
          email: "editor@new-media.example",
          role: "Видеоредакция",
        }),
      ],
      opportunityStageData: expect.objectContaining({
        rutubeUseCase: expect.stringContaining("видеоновости"),
      }),
    });
  });

  it("помечает дубль действующей организации и защищает от устаревшей версии", async () => {
    const service = new RadarService(new TodayService(), new FoundInspector(), fixedClock);
    const duplicate = service.create(
      {
        ...candidateCommand(),
        name: "Дубль Медиа Новости",
        url: "https://www.medianovosti.ru/article",
      },
      "radar-create-key-0020",
    );
    const inspected = await service.inspect(duplicate.id, "radar-check-key-0020");

    expect(inspected.duplicateOrganization).toMatchObject({
      id: "org-task-1",
      name: "Медиа Новости",
    });
    expect(inspected.score.factors).toContainEqual(
      expect.objectContaining({
        code: "duplicate-partner",
        value: -40,
      }),
    );
    expect(() =>
      service.adjustScore(
        duplicate.id,
        {
          version: 1,
          adjustment: 1,
          comment: "Устаревшая форма",
        },
        "radar-score-key-0020",
      ),
    ).toThrow(RadarCandidateVersionConflictError);
    let duplicateError: unknown;
    try {
      service.decide(
        duplicate.id,
        {
          version: inspected.version,
          decision: "accept",
          reason: "Попытка принять дубль",
        },
        "radar-decision-key-0020",
      );
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toMatchObject({ code: "RAD-002" });
  });

  it("добавляет в карточку автоматически собранные признаки и пересчитывает score", async () => {
    const service = new RadarService(new TodayService(), new FoundInspector(), fixedClock);
    const created = service.create(
      {
        name: "Спортивная площадка",
        url: "https://sports-research.example/",
        source: "Ручной поиск",
      },
      "radar-create-key-0030",
    );

    const inspected = await service.inspect(created.id, "radar-check-key-0030");

    expect(inspected.features).toMatchObject({
      topic: "Спорт",
      language: "ru",
      geography: "Россия",
      publicationFrequency: "daily",
      contactsFound: true,
      cms: "WordPress",
      estimatedVideoPagesMin: 4,
      estimatedVideoPagesMax: 4,
    });
    expect(inspected.research).toMatchObject({
      method: "html-signals-v1",
      decisionMakers: [],
      signals: expect.arrayContaining([
        expect.objectContaining({ field: "topic", confidence: "medium" }),
      ]),
    });
    expect(inspected.score.total).toBeGreaterThan(created.score.total);
  });
});

class FoundInspector {
  async inspect(pageUrl: string): Promise<RadarInspectionObservation> {
    return {
      pageUrl,
      status: "found",
      playerType: "RUTUBE",
      detectedAt: fixedClock(),
      method: "l0-html",
      confidence: "high",
      httpStatus: 200,
      playerFound: true,
      embedUrl: "https://rutube.ru/play/embed/video-id",
      errorCode: null,
      featureExtraction: {
        features: {
          topic: "Спорт",
          language: "ru",
          geography: "Россия",
          publicationFrequency: "daily",
          contactsFound: true,
          cms: "WordPress",
          estimatedVideoPagesMin: 4,
          estimatedVideoPagesMax: 4,
        },
        research: {
          method: "html-signals-v1",
          decisionMakers: [],
          pageUrl,
          collectedAt: fixedClock().toISOString(),
          signals: [
            {
              field: "topic",
              label: "Тематика",
              value: "Спорт",
              source: "title и meta description",
              confidence: "medium",
            },
          ],
          contacts: [
            {
              type: "email",
              value: "editor@new-media.example",
              href: "mailto:editor@new-media.example",
              sourceUrl: pageUrl,
              confidence: "high",
            },
          ],
          videoPages: [
            {
              pageUrl,
              label: "Видеоновости",
              sourceUrl: pageUrl,
              confidence: "medium",
            },
          ],
          brief: {
            readiness: "ready_for_outreach",
            siteSummary: "Новости, Россия, публикации — ежедневно.",
            videoUsage: "Найдена видеостраница.",
            rutubeUseCase: "видеоновости и репортажи в RUTUBE-плеере",
            likelyContactRoles: ["Видеоредакция", "Коммерческий отдел"],
            risks: ["Трафик не подтверждён внешним провайдером."],
            nextAction:
              "Связаться через editor@new-media.example и запросить пример видеостраницы.",
          },
          notes: ["Автоматический сбор"],
        },
      },
    };
  }
}

function candidateCommand() {
  return {
    name: "Новые медиа",
    url: "https://www.new-media.example/news/video#player",
    source: "Ручной поиск",
    topic: "Новости",
    language: "ru",
    geography: "Россия",
    publicationFrequency: "daily",
    contactsFound: true,
    cms: "WordPress",
    estimatedVideoPagesMin: 20,
    estimatedVideoPagesMax: 150,
    trafficEstimate: {
      provider: "Оценка аналитика",
      measuredAt: "2026-08-18T09:00:00.000Z",
      minMonthlyVisits: 250_000,
      maxMonthlyVisits: 1_100_000,
      confidence: "medium",
    },
  };
}

function fixedClock() {
  return new Date("2026-08-18T10:00:00.000Z");
}
