import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RadarPageInspector,
  findVideoPattern,
  robotsAllows,
  type RadarHttpReader,
} from "./radar-page-inspector.js";
import type { PlayerDetection } from "./player-signatures.js";
import type { RadarPageRenderer, RenderedPageObservation } from "./radar-page-renderer.js";

describe("RadarPageInspector", () => {
  it("honors robots.txt and detects a documented RUTUBE iframe", async () => {
    const requests: string[] = [];
    const reader: RadarHttpReader = {
      async get(url) {
        requests.push(url);
        return response(
          url,
          url.endsWith("/robots.txt")
            ? "User-agent: *\nAllow: /video"
            : '<iframe src="https://rutube.ru/play/embed/abc123/"></iframe>',
        );
      },
    };
    const inspector = new RadarPageInspector(reader, () => new Date("2026-08-18T12:00:00.000Z"));

    const observation = await inspector.inspect("https://media.example/video/article");

    expect(requests).toEqual([
      "https://media.example/robots.txt",
      "https://media.example/video/article",
    ]);
    expect(observation).toMatchObject({
      status: "found",
      playerType: "RUTUBE",
      playerFound: true,
      confidence: "high",
      httpStatus: 200,
    });
  });

  it("does not fetch a page forbidden by robots.txt", async () => {
    let calls = 0;
    const inspector = new RadarPageInspector({
      async get(url) {
        calls += 1;
        return response(url, "User-agent: *\nDisallow: /private");
      },
    });

    const observation = await inspector.inspect("https://media.example/private/video");

    expect(calls).toBe(1);
    expect(observation).toMatchObject({ status: "blocked", errorCode: "ROBOTS_DISALLOWED" });
  });

  it("crawls at most three same-origin business pages and merges LPR evidence", async () => {
    const requests: string[] = [];
    const pages: Record<string, string> = {
      "https://media.example/": `
        <a href="/contacts">Контакты</a>
        <a href="/team">Команда</a>
        <a href="/editorial">Редакция</a>
        <a href="/about">О компании</a>
        <a href="https://outside.example/management">Внешнее руководство</a>`,
      "https://media.example/contacts":
        '<a href="mailto:sales@media.example">sales@media.example</a>',
      "https://media.example/team":
        '<article><b>Анна Смирнова</b><span>Директор по развитию</span><a href="mailto:anna@media.example">Email</a></article>',
      "https://media.example/editorial":
        "<article><b>Иван Орлов</b><span>Главный редактор</span></article>",
      "https://media.example/about": "Эта четвёртая страница не должна загружаться",
    };
    const reader: RadarHttpReader = {
      async get(url) {
        requests.push(url);
        return response(
          url,
          url.endsWith("/robots.txt") ? "User-agent: *\nAllow: /" : (pages[url] ?? ""),
        );
      },
    };

    const observation = await new RadarPageInspector(reader).inspect("https://media.example/");

    expect(requests).toEqual([
      "https://media.example/robots.txt",
      "https://media.example/",
      "https://media.example/contacts",
      "https://media.example/team",
      "https://media.example/editorial",
    ]);
    expect(observation.featureExtraction?.research.decisionMakers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fullName: "Анна Смирнова", role: "Директор по развитию" }),
        expect.objectContaining({ fullName: "Иван Орлов", role: "Главный редактор" }),
      ]),
    );
    expect(requests).not.toContain("https://outside.example/management");
  });

  it("uses declared sitemap and RSS to sample the site and estimates research coverage", async () => {
    const requests: string[] = [];
    const pages: Record<string, string> = {
      "https://media.example/": `
        <html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>
        <body><a href="/contacts">Контакты</a></body></html>`,
      "https://media.example/sitemap.xml": `<?xml version="1.0"?><urlset>
        <url><loc>https://media.example/news/1</loc></url>
        <url><loc>https://media.example/video/2</loc></url>
        <url><loc>https://outside.example/private</loc></url>
      </urlset>`,
      "https://media.example/feed.xml": `<?xml version="1.0"?><rss><channel>
        <item><link>https://media.example/news/3</link></item>
      </channel></rss>`,
      "https://media.example/contacts":
        '<p>По вопросам сотрудничества <a href="mailto:partner@media.example">partner@media.example</a></p>',
      "https://media.example/news/1":
        '<time datetime="2026-08-20T09:00:00Z"></time><p>Новости спорта</p>',
      "https://media.example/video/2": '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
      "https://media.example/news/3":
        '<time datetime="2026-08-20T10:00:00Z"></time><p>Свежие новости</p>',
    };
    const reader: RadarHttpReader = {
      async get(url) {
        requests.push(url);
        if (url.endsWith("/robots.txt")) {
          return response(
            url,
            "User-agent: *\nAllow: /\nSitemap: https://media.example/sitemap.xml",
          );
        }
        const body = pages[url] ?? "";
        return response(url, body, url.endsWith(".xml") ? "application/xml" : "text/html");
      },
    };

    const observation = await new RadarPageInspector(reader).inspect("https://media.example/");

    expect(requests).toContain("https://media.example/sitemap.xml");
    expect(requests).toContain("https://media.example/feed.xml");
    expect(requests).not.toContain("https://outside.example/private");
    expect(observation.featureExtraction?.research).toMatchObject({
      method: "site-intelligence-v2",
      coverage: {
        discoveredUrls: 5,
        inspectedUrls: 5,
        sitemapUrls: 2,
        feedUrls: 1,
        videoPagesObserved: 1,
        coveragePercent: 100,
      },
      brief: {
        opportunityPotential: {
          observedVideoSharePercent: 20,
        },
      },
    });
    expect(observation.featureExtraction?.research.decisionMakers).toContainEqual(
      expect.objectContaining({ role: "Ответственный за сотрудничество" }),
    );
  });
});

describe("RadarPageInspector player signatures and L1 fallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats a competitor iframe in static HTML as confirmed video", async () => {
    const reader = staticReader({
      "https://media.example/": '<iframe src="https://vk.com/video_ext.php?oid=1&id=2"></iframe>',
    });
    const renderer = new FakeRenderer([]);

    const observation = await new RadarPageInspector(reader, undefined, null, renderer).inspect(
      "https://media.example/",
    );

    expect(observation).toMatchObject({
      status: "found",
      playerFound: true,
      playerType: "VK Видео",
      competitorPlayerDetected: true,
    });
    expect(observation.detectedPlayers).toEqual([
      expect.objectContaining({ vendor: "vk", via: "static", competitor: true }),
    ]);
    // Static analysis succeeded, so the L1 budget is never spent.
    expect(renderer.calls).toEqual([]);
    expect(observation.featureExtraction?.research.brief.priorityInsights?.[0]).toMatchObject({
      code: "player",
      label: "Уже использует сторонний видеохостинг",
    });
    expect(observation.featureExtraction?.research.brief.whyNow).toContain(
      "сценарий миграции на RUTUBE-плеер",
    );
  });

  it("escalates to the headless renderer when static HTML has no video patterns", async () => {
    const reader = staticReader({
      "https://media.example/": '<a href="/contacts">Контакты</a>',
      "https://media.example/contacts": "<p>Пишите нам</p>",
    });
    const renderer = new FakeRenderer([
      {
        url: "https://media.example/",
        ok: true,
        players: [detection("kinescope", "Kinescope", true, "iframe")],
      },
    ]);

    const observation = await new RadarPageInspector(reader, undefined, null, renderer).inspect(
      "https://media.example/",
    );

    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]![0]).toBe("https://media.example/");
    expect(renderer.calls[0]!.length).toBeLessThanOrEqual(3);
    expect(observation).toMatchObject({
      status: "found",
      playerType: "Kinescope",
      confidence: "medium",
      competitorPlayerDetected: true,
    });
    expect(observation.detectedPlayers).toEqual([
      expect.objectContaining({ vendor: "kinescope", via: "rendered" }),
    ]);
  });

  it("stays not_found when both static analysis and the renderer see no players", async () => {
    const reader = staticReader({ "https://media.example/": "<main>Только текст</main>" });
    const renderer = new FakeRenderer([{ url: "https://media.example/", ok: true, players: [] }]);

    const observation = await new RadarPageInspector(reader, undefined, null, renderer).inspect(
      "https://media.example/",
    );

    expect(observation).toMatchObject({
      status: "not_found",
      errorCode: "VIDEO_PATTERN_NOT_FOUND",
      detectedPlayers: [],
      competitorPlayerDetected: false,
    });
  });

  it("skips L1 when RADAR_L1_ENABLED=0", async () => {
    vi.stubEnv("RADAR_L1_ENABLED", "0");
    const reader = staticReader({ "https://media.example/": "<main>Только текст</main>" });
    const renderer = new FakeRenderer([
      {
        url: "https://media.example/",
        ok: true,
        players: [detection("youtube", "YouTube", true, "iframe")],
      },
    ]);

    const observation = await new RadarPageInspector(reader, undefined, null, renderer).inspect(
      "https://media.example/",
    );

    expect(renderer.calls).toEqual([]);
    expect(observation.status).toBe("not_found");
  });

  it("keeps the L0 result when the renderer itself fails", async () => {
    const reader = staticReader({ "https://media.example/": "<main>Только текст</main>" });
    const renderer: RadarPageRenderer = {
      render: async () => {
        throw new Error("browser crashed");
      },
    };

    const observation = await new RadarPageInspector(reader, undefined, null, renderer).inspect(
      "https://media.example/",
    );

    expect(observation).toMatchObject({ status: "not_found", detectedPlayers: [] });
  });
});

class FakeRenderer implements RadarPageRenderer {
  readonly calls: string[][] = [];
  constructor(private readonly results: RenderedPageObservation[]) {}
  async render(urls: string[]): Promise<RenderedPageObservation[]> {
    this.calls.push(urls);
    return this.results;
  }
}

function detection(
  vendor: string,
  label: string,
  competitor: boolean,
  kind: PlayerDetection["kind"],
): PlayerDetection {
  return { vendor, label, competitor, kind };
}

function staticReader(pages: Record<string, string>): RadarHttpReader {
  return {
    async get(url) {
      return response(
        url,
        url.endsWith("/robots.txt") ? "User-agent: *\nAllow: /" : (pages[url] ?? ""),
      );
    },
  };
}

describe("radar HTML and robots rules", () => {
  it("recognizes supported player patterns without starting playback", () => {
    expect(findVideoPattern('<video controls src="movie.mp4"></video>')).toMatchObject({
      playerType: "HTML5 video",
      confidence: "high",
    });
    expect(findVideoPattern("<main>Текст без видео</main>")).toBeNull();
  });

  it("uses the longest matching allow/disallow rule", () => {
    expect(
      robotsAllows("User-agent: *\nDisallow: /media\nAllow: /media/public", "/media/public/video"),
    ).toBe(true);
  });
});

function response(url: string, body: string, contentType = "text/html; charset=utf-8") {
  return {
    url: new URL(url),
    status: 200,
    headers: { "content-type": contentType },
    body: Buffer.from(body),
  };
}
