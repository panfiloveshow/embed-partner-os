import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightPageRenderer } from "./playwright-page-renderer.js";

/**
 * Local smoke test for the L1 renderer: a fixture page inserts a competitor
 * iframe from JavaScript, which static HTML analysis can never see.
 *
 * The whole suite is skipped when Playwright or the Chromium binary is not
 * installed, so a browserless CI stays green. The renderer itself degrades
 * gracefully in that case (see the unit test at the bottom).
 */
const browserAvailable = await (async () => {
  try {
    const { chromium } = await import("playwright");
    return Boolean(chromium.executablePath());
  } catch {
    return false;
  }
})();

const FIXTURE_HTML = `<!doctype html>
<html><head><title>Fixture</title></head>
<body>
  <main>Текст без единого видео в статике</main>
  <script>
    setTimeout(() => {
      const frame = document.createElement("iframe");
      frame.src = "https://vk.com/video_ext.php?oid=1&id=2";
      document.body.appendChild(frame);
    }, 100);
  </script>
</body></html>`;

describe.skipIf(!browserAvailable)("PlaywrightPageRenderer (chromium smoke)", () => {
  let server: Server;
  let baseUrl: string;
  let renderer: PlaywrightPageRenderer;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/js-embed") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(FIXTURE_HTML);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    renderer = new PlaywrightPageRenderer({
      // Loopback is blocked by the production SSRF policy; the smoke fixture
      // explicitly allows only its own host.
      allowHost: (hostname) => hostname === "127.0.0.1",
      settleMs: 500,
    });
  }, 60_000);

  afterAll(async () => {
    await renderer?.close();
    await new Promise<void>((resolve, reject) =>
      server ? server.close((error) => (error ? reject(error) : resolve())) : resolve(),
    );
  });

  it(
    "finds a JS-inserted competitor iframe that static HTML misses",
    { timeout: 60_000 },
    async () => {
      const [result] = await renderer.render([`${baseUrl}/js-embed`]);

      expect(result).toMatchObject({ ok: true });
      expect(result!.players).toEqual([
        expect.objectContaining({ vendor: "vk", competitor: true, kind: "iframe" }),
      ]);
    },
  );

  it("renders at most three pages per call", { timeout: 60_000 }, async () => {
    const urls = [1, 2, 3, 4, 5].map(() => `${baseUrl}/js-embed`);
    const results = await renderer.render(urls);
    expect(results).toHaveLength(3);
  });

  it("blocks navigation to hosts outside the allow policy", { timeout: 60_000 }, async () => {
    // localhost resolves to loopback and is rejected by the shared guard
    // (allowHost above only admits 127.0.0.1 verbatim).
    const { port } = server.address() as AddressInfo;
    const [result] = await renderer.render([`http://localhost:${port}/js-embed`]);
    expect(result).toMatchObject({ ok: false });
    expect(result!.players).toEqual([]);
  });
});

describe("PlaywrightPageRenderer without a browser", () => {
  it("skips gracefully when chromium cannot be launched", async () => {
    const renderer = new PlaywrightPageRenderer({ logger: { warn: () => undefined } });
    // Simulate the cached launch failure regardless of the local environment.
    (renderer as unknown as { browserPromise: Promise<null> }).browserPromise =
      Promise.resolve(null);

    const results = await renderer.render(["https://media.example/"]);

    expect(results).toEqual([]);
    await renderer.close();
  });

  it("returns nothing for an empty URL budget without touching the browser", async () => {
    const renderer = new PlaywrightPageRenderer({ logger: { warn: () => undefined } });
    expect(await renderer.render([])).toEqual([]);
    expect(await renderer.render(["https://media.example/"], { maxPages: 0 })).toEqual([]);
  });
});
