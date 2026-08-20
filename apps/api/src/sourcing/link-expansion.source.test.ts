import { describe, expect, it } from "vitest";
import type { SafeHttpClient, SafeHttpResponse } from "../monitoring/safe-http-client.js";
import {
  extractExternalMediaDomains,
  LinkExpansionCandidateSource,
} from "./link-expansion.source.js";

describe("extractExternalMediaDomains", () => {
  it("collects external .ru/.рф domains, skipping own site, socials and non-ru hosts", () => {
    const html = `
      <a href="https://www.regional-news.ru/top">Новости</a>
      <a href="https://vk.com/somepage">VK</a>
      <a href="https://dzen.ru/media">Дзен</a>
      <a href="https://t.me/channel">TG</a>
      <a href="https://www.youtube.com/watch?v=1">YouTube</a>
      <a href="https://example.com/global">example.com</a>
      <a href="/local/page">local</a>
      <a href="https://sub.base-site.ru/section">own subdomain</a>
      <a href="https://Sport-Life.RU/">спорт</a>
      <a href='https://xn--80aaifmgl1achx.xn--p1ai/'>кириллический</a>
      <a href="mailto:editor@base-site.ru">почта</a>
    `;
    expect(extractExternalMediaDomains(html, "base-site.ru")).toEqual([
      "regional-news.ru",
      "sport-life.ru",
      "xn--80aaifmgl1achx.xn--p1ai",
    ]);
  });

  it("caps the number of domains per page", () => {
    const html = Array.from(
      { length: 15 },
      (_, index) => `<a href="https://site-${index}.ru/">x</a>`,
    ).join("\n");
    expect(extractExternalMediaDomains(html, "base.ru", 10)).toHaveLength(10);
  });

  it("dedups repeated links to the same domain", () => {
    const html = `
      <a href="https://media.ru/a">a</a>
      <a href="https://www.media.ru/b">b</a>
      <a href="http://media.ru/c">c</a>
    `;
    expect(extractExternalMediaDomains(html, "base.ru")).toEqual(["media.ru"]);
  });
});

function fakeHttp(pages: Record<string, string>): Pick<SafeHttpClient, "get"> {
  return {
    async get(input: string): Promise<SafeHttpResponse> {
      const url = new URL(input);
      const html = pages[url.hostname];
      if (html === undefined) throw new Error(`unexpected fetch: ${input}`);
      return { url, status: 200, headers: {}, body: Buffer.from(html, "utf8") };
    },
  };
}

describe("LinkExpansionCandidateSource", () => {
  it("expands accepted partner homepages into look-alike candidates with a note", async () => {
    const linkSource = new LinkExpansionCandidateSource(
      { listExpansionRoots: async () => ["partner-one.ru", "partner-two.ru"] },
      fakeHttp({
        "partner-one.ru": '<a href="https://lookalike.ru/">x</a><a href="https://vk.com/p">vk</a>',
        "partner-two.ru": '<a href="https://lookalike.ru/">x</a><a href="https://other.ru/">y</a>',
      }),
    );

    const candidates = await linkSource.fetchCandidates();

    expect(candidates).toEqual([
      {
        siteName: "lookalike.ru",
        url: "https://lookalike.ru/",
        note: "найден по ссылке с partner-one.ru",
      },
      { siteName: "other.ru", url: "https://other.ru/", note: "найден по ссылке с partner-two.ru" },
    ]);
  });

  it("never suggests a root domain and survives a fetch failure", async () => {
    const linkSource = new LinkExpansionCandidateSource(
      { listExpansionRoots: async () => ["broken.ru", "partner.ru"] },
      {
        async get(input: string): Promise<SafeHttpResponse> {
          const url = new URL(input);
          if (url.hostname === "broken.ru") throw new Error("blocked");
          return {
            url,
            status: 200,
            headers: {},
            body: Buffer.from(
              '<a href="https://broken.ru/">root</a><a href="https://new-site.ru/">n</a>',
              "utf8",
            ),
          };
        },
      },
    );

    const candidates = await linkSource.fetchCandidates();
    expect(candidates.map(({ siteName }) => siteName)).toEqual(["new-site.ru"]);
  });

  it("respects the per-cycle site limit", async () => {
    const fetched: string[] = [];
    const linkSource = new LinkExpansionCandidateSource(
      { listExpansionRoots: async (limit) => ["a.ru", "b.ru"].slice(0, limit) },
      {
        async get(input: string): Promise<SafeHttpResponse> {
          fetched.push(input);
          return { url: new URL(input), status: 200, headers: {}, body: Buffer.alloc(0) };
        },
      },
      1,
    );
    await linkSource.fetchCandidates();
    expect(fetched).toEqual(["https://a.ru/"]);
  });
});
