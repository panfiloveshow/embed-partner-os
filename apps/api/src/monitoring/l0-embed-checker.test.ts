import { describe, expect, it } from "vitest";
import {
  L0EmbedChecker,
  findDocumentedRutubeEmbed,
  type HttpReader,
} from "./l0-embed-checker.js";

describe("RUTUBE L0 embed checker", () => {
  it("recognizes only the documented RUTUBE play/embed iframe URL", () => {
    expect(findDocumentedRutubeEmbed(`
      <iframe src="https://rutube.ru/play/embed/7716bd3e665725c3c008ae7ab4ff02e2?skinColor=e53935"></iframe>
    `)).toBe("https://rutube.ru/play/embed/7716bd3e665725c3c008ae7ab4ff02e2?skinColor=e53935");
    expect(findDocumentedRutubeEmbed(
      `<iframe src="https://evil.example/?next=https://rutube.ru/play/embed/fake"></iframe>`,
    )).toBeNull();
    expect(findDocumentedRutubeEmbed(
      `<iframe src="https://rutube.ru.evil.example/play/embed/fake"></iframe>`,
    )).toBeNull();
  });

  it("returns healthy without executing the player when page and embed respond", async () => {
    const reader = new SequenceReader([
      response(200, `<iframe src="https://rutube.ru/play/embed/video-id"></iframe>`),
      response(200, "<html>player shell</html>"),
    ]);
    const checker = new L0EmbedChecker(reader, () => new Date("2026-08-18T09:00:00.000Z"));

    await expect(checker.check("https://partner.example/article")).resolves.toMatchObject({
      checkedAt: new Date("2026-08-18T09:00:00.000Z"),
      result: "healthy",
      pageHttpStatus: 200,
      embedHttpStatus: 200,
      playerFound: true,
      embedUrl: "https://rutube.ru/play/embed/video-id",
      errorCode: null,
    });
    expect(reader.urls).toEqual([
      "https://partner.example/article",
      "https://rutube.ru/play/embed/video-id",
    ]);
  });

  it("classifies policy blocks separately from confirmed player failures", async () => {
    const blocked = new L0EmbedChecker(new SequenceReader([response(429, "rate limited")]));
    const missing = new L0EmbedChecker(new SequenceReader([response(200, "<main>No player</main>")]));

    await expect(blocked.check("https://partner.example/article")).resolves.toMatchObject({
      result: "blocked",
      errorCode: "PAGE_HTTP_BLOCKED",
    });
    await expect(missing.check("https://partner.example/article")).resolves.toMatchObject({
      result: "failed",
      errorCode: "RUTUBE_IFRAME_NOT_FOUND",
    });
  });
});

class SequenceReader implements HttpReader {
  readonly urls: string[] = [];
  constructor(private readonly responses: Array<Awaited<ReturnType<HttpReader["get"]>>>) {}

  async get(url: string) {
    this.urls.push(url);
    const next = this.responses.shift();
    if (!next) throw new Error("No response configured");
    return next;
  }
}

function response(status: number, body: string) {
  return {
    url: new URL("https://partner.example/article"),
    status,
    headers: { "content-type": "text/html" },
    body: Buffer.from(body),
  };
}
