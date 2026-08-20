import { describe, expect, it } from "vitest";
import { emptyRadarFeatures } from "@embed-os/domain";
import {
  enrichRadarResearchWithChanges,
  extractRadarPageFeatures,
  mergeRadarFeatures,
} from "./radar-feature-extractor.js";

describe("Radar page feature extraction", () => {
  it("collects the qualification signals available in public HTML", () => {
    const html = `
      <html lang="ru"><head>
        <title>Новости спорта, трансляции и видео</title>
        <meta name="description" content="Свежие новости российского спорта, матчи и интервью">
        <meta name="generator" content="WordPress 6.6">
      </head><body>
        <time datetime="2026-08-19T12:00:00+03:00"></time>
        <time datetime="2026-08-19T10:00:00+03:00"></time>
        <time datetime="2026-08-18T18:00:00+03:00"></time>
        <a href="/video/match-review">Видео матча</a>
        <a href="mailto:editor@example.ru">Редакция</a>
        <a href="tel:+7 (495) 123-45-67">Телефон редакции</a>
        <a href="/contacts">Все контакты</a>
        <a href="https://partner.example.com/about">О партнёре</a>
      </body></html>`;

    const result = extractRadarPageFeatures(
      html,
      new URL("https://sport.example.ru/"),
      new Date("2026-08-19T12:30:00.000Z"),
    );

    expect(result.features).toMatchObject({
      topic: "Спорт",
      language: "ru",
      geography: "Россия",
      publicationFrequency: "daily",
      contactsFound: true,
      cms: "WordPress",
      estimatedVideoPagesMin: 1,
      estimatedVideoPagesMax: 1,
    });
    expect(result.research.signals.map(({ field }) => field)).toEqual(
      expect.arrayContaining([
        "topic",
        "language",
        "geography",
        "publicationFrequency",
        "contactsFound",
        "cms",
        "estimatedVideoPages",
      ]),
    );
    expect(result.research.contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "email",
          value: "editor@example.ru",
          href: "mailto:editor@example.ru",
          sourceUrl: "https://sport.example.ru/",
          confidence: "high",
        }),
        expect.objectContaining({ type: "phone", value: "+74951234567" }),
        expect.objectContaining({
          type: "contact_page",
          href: "https://sport.example.ru/contacts",
        }),
      ]),
    );
    expect(result.research.contacts).not.toContainEqual(
      expect.objectContaining({
        href: "https://partner.example.com/about",
      }),
    );
    expect(result.research.decisionMakers).toEqual([]);
    expect(result.research.videoPages).toContainEqual(
      expect.objectContaining({
        pageUrl: "https://sport.example.ru/video/match-review",
        label: "Видео матча",
      }),
    );
    expect(result.research.brief).toMatchObject({
      readiness: "ready_for_outreach",
      siteSummary: expect.stringContaining("Спорт"),
      videoUsage: expect.stringContaining("Видео матча"),
      rutubeUseCase: expect.stringContaining("хайлайт"),
      likelyContactRoles: expect.arrayContaining(["Видеоредакция"]),
      risks: expect.arrayContaining([expect.stringContaining("Трафик")]),
      nextAction: expect.stringContaining("editor@example.ru"),
      whyNow: expect.stringContaining("публикует"),
      priorityInsights: expect.arrayContaining([
        expect.objectContaining({ code: "publishing" }),
        expect.objectContaining({ code: "video" }),
        expect.objectContaining({ code: "contact" }),
      ]),
      outreach: expect.objectContaining({
        channel: "email",
        destination: "editor@example.ru",
        messageDraft: expect.stringContaining("RUTUBE"),
        discoveryQuestions: expect.arrayContaining([expect.stringContaining("видео")]),
      }),
    });
  });

  it("extracts a named decision maker only when the public page confirms a business role", () => {
    const html = `
      <html lang="ru"><body>
        <section class="team-card">
          <h2>Мария Иванова</h2>
          <p>Коммерческий директор</p>
          <a href="mailto:m.ivanova@example.ru">m.ivanova@example.ru</a>
          <a href="tel:+7 495 222-33-44">Позвонить</a>
        </section>
        <script type="application/ld+json">{
          "@context": "https://schema.org",
          "@type": "Person",
          "name": "Алексей Петров",
          "jobTitle": "Главный редактор",
          "email": "editor@example.ru",
          "url": "/team/alexey-petrov"
        }</script>
      </body></html>`;

    const result = extractRadarPageFeatures(
      html,
      new URL("https://media.example.ru/team"),
      new Date("2026-08-19T12:30:00.000Z"),
    );

    expect(result.research.decisionMakers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullName: "Мария Иванова",
          role: "Коммерческий директор",
          email: "m.ivanova@example.ru",
          phone: "+74952223344",
          sourceUrl: "https://media.example.ru/team",
          confidence: "high",
        }),
        expect.objectContaining({
          fullName: "Алексей Петров",
          role: "Главный редактор",
          email: "editor@example.ru",
          profileUrl: "https://media.example.ru/team/alexey-petrov",
        }),
      ]),
    );
    expect(result.research.brief.nextAction).toContain("Мария Иванова");
  });

  it("keeps a role-specific business mailbox as a target contact without inventing a person's name", () => {
    const result = extractRadarPageFeatures(
      '<p>По вопросам сотрудничества <a href="mailto:ivan@example.ru">ivan@example.ru</a></p>',
      new URL("https://media.example.ru/feedback"),
      new Date("2026-08-19T12:30:00.000Z"),
    );

    expect(result.research.decisionMakers).toContainEqual(
      expect.objectContaining({
        fullName: null,
        role: "Ответственный за сотрудничество",
        department: "Развитие бизнеса",
        email: "ivan@example.ru",
        confidence: "medium",
      }),
    );
    expect(result.research.brief.nextAction).toContain("Ответственный за сотрудничество");
    expect(result.research.brief.nextAction).toContain("ivan@example.ru");
  });

  it("fills missing fields without replacing information entered by an analyst", () => {
    const current = emptyRadarFeatures({
      name: "Площадка",
      url: "https://example.ru/",
      source: "Ручной поиск",
      topic: "Авторская тематика",
      contactsFound: false,
    });
    const extracted = extractRadarPageFeatures(
      '<html lang="ru"><meta name="description" content="Новости российского спорта"><a href="tel:+70000000000">Позвонить</a></html>',
      new URL("https://example.ru/"),
      new Date("2026-08-19T12:30:00.000Z"),
    );

    expect(mergeRadarFeatures(current, extracted.features)).toMatchObject({
      topic: "Авторская тематика",
      language: "ru",
      geography: "Россия",
      contactsFound: true,
    });
  });

  it("raises newly discovered LPR and video growth as reasons to act now", () => {
    const previous = extractRadarPageFeatures(
      "<html><body><p>Архив публикаций</p></body></html>",
      new URL("https://media.example.ru/"),
      new Date("2026-08-13T12:00:00.000Z"),
    ).research;
    const current = extractRadarPageFeatures(
      `<html><body>
        <section class="team"><b>Анна Смирнова</b><span>Директор по развитию</span><a href="mailto:anna@media.example.ru">Email</a></section>
        <iframe src="https://rutube.ru/play/embed/abc"></iframe>
      </body></html>`,
      new URL("https://media.example.ru/"),
      new Date("2026-08-20T12:00:00.000Z"),
    ).research;

    const enriched = enrichRadarResearchWithChanges(previous, current);

    expect(enriched.changeSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "new_lpr" }),
        expect.objectContaining({ code: "new_contact" }),
        expect.objectContaining({ code: "video_growth" }),
      ]),
    );
    expect(enriched.brief.priorityInsights?.[0]).toMatchObject({ code: "timing" });
    expect(enriched.brief.whyNow).toContain("Найдены новые целевые контакты");
  });
});
