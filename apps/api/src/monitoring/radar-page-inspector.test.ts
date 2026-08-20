import { describe, expect, it } from "vitest";
import { RadarPageInspector, findVideoPattern, robotsAllows, type RadarHttpReader } from "./radar-page-inspector.js";

describe("RadarPageInspector", () => {
  it("honors robots.txt and detects a documented RUTUBE iframe", async () => {
    const requests: string[] = [];
    const reader: RadarHttpReader = {
      async get(url) {
        requests.push(url);
        return response(url, url.endsWith("/robots.txt")
          ? "User-agent: *\nAllow: /video"
          : '<iframe src="https://rutube.ru/play/embed/abc123/"></iframe>');
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
      "https://media.example/contacts": '<a href="mailto:sales@media.example">sales@media.example</a>',
      "https://media.example/team": '<article><b>Анна Смирнова</b><span>Директор по развитию</span><a href="mailto:anna@media.example">Email</a></article>',
      "https://media.example/editorial": '<article><b>Иван Орлов</b><span>Главный редактор</span></article>',
      "https://media.example/about": "Эта четвёртая страница не должна загружаться",
    };
    const reader: RadarHttpReader = {
      async get(url) {
        requests.push(url);
        return response(url, url.endsWith("/robots.txt") ? "User-agent: *\nAllow: /" : pages[url] ?? "");
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
    expect(observation.featureExtraction?.research.decisionMakers).toEqual(expect.arrayContaining([
      expect.objectContaining({ fullName: "Анна Смирнова", role: "Директор по развитию" }),
      expect.objectContaining({ fullName: "Иван Орлов", role: "Главный редактор" }),
    ]));
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
      "https://media.example/contacts": '<p>По вопросам сотрудничества <a href="mailto:partner@media.example">partner@media.example</a></p>',
      "https://media.example/news/1": '<time datetime="2026-08-20T09:00:00Z"></time><p>Новости спорта</p>',
      "https://media.example/video/2": '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
      "https://media.example/news/3": '<time datetime="2026-08-20T10:00:00Z"></time><p>Свежие новости</p>',
    };
    const reader: RadarHttpReader = {
      async get(url) {
        requests.push(url);
        if (url.endsWith("/robots.txt")) {
          return response(url, "User-agent: *\nAllow: /\nSitemap: https://media.example/sitemap.xml");
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

describe("radar HTML and robots rules", () => {
  it("recognizes supported player patterns without starting playback", () => {
    expect(findVideoPattern('<video controls src="movie.mp4"></video>')).toMatchObject({
      playerType: "HTML5 video",
      confidence: "high",
    });
    expect(findVideoPattern("<main>Текст без видео</main>")).toBeNull();
  });

  it("uses the longest matching allow/disallow rule", () => {
    expect(robotsAllows(
      "User-agent: *\nDisallow: /media\nAllow: /media/public",
      "/media/public/video",
    )).toBe(true);
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
