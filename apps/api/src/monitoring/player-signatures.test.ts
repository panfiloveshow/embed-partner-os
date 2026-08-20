import { describe, expect, it } from "vitest";
import {
  detectPlayersInHtml,
  detectPlayersInSources,
  toRadarDetectedPlayers,
} from "./player-signatures.js";

describe("player signature catalog", () => {
  it("recognizes RUTUBE as a non-competitor embed", () => {
    const players = detectPlayersInHtml(
      '<iframe src="https://rutube.ru/play/embed/abc123/"></iframe>',
    );
    expect(players).toEqual([
      expect.objectContaining({
        vendor: "rutube",
        label: "RUTUBE",
        competitor: false,
        kind: "iframe",
        sampleUrl: "https://rutube.ru/play/embed/abc123/",
      }),
    ]);
  });

  it.each([
    ["https://vk.com/video_ext.php?oid=1&id=2", "vk"],
    ["https://vkvideo.ru/video_ext.php?oid=1&id=2", "vk"],
    ["https://www.youtube.com/embed/xyz", "youtube"],
    ["https://www.youtube-nocookie.com/embed/xyz", "youtube"],
    ["https://kinescope.io/embed/abcdef", "kinescope"],
    ["https://ok.ru/videoembed/123456", "ok"],
    ["https://dzen.ru/embed/vabc?from_block=partner", "dzen"],
    ["https://player.smotrim.ru/iframe/video/id/12345", "smotrim"],
    ["https://player.vimeo.com/video/123", "vimeo"],
  ])("recognizes %s as a competitor iframe (%s)", (src, vendor) => {
    const players = detectPlayersInHtml(`<iframe src="${src}"></iframe>`);
    expect(players).toEqual([
      expect.objectContaining({ vendor, competitor: true, kind: "iframe" }),
    ]);
  });

  it("recognizes generic self-hosted players as non-competitors", () => {
    const html = `
      <script src="https://content.jwplatform.com/libraries/abc.js"></script>
      <script src="https://vjs.zencdn.net/8.10.0/video.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
      <video class="video-js" controls></video>`;
    const players = detectPlayersInHtml(html);
    const vendors = players.map(({ vendor }) => vendor).sort();
    expect(vendors).toEqual(["hlsjs", "html5-video", "jwplayer", "videojs"]);
    expect(players.every(({ competitor }) => !competitor)).toBe(true);
  });

  it("detects inline player constructors without script URLs", () => {
    expect(detectPlayersInHtml("<script>jwplayer('root').setup({});</script>")).toEqual([
      expect.objectContaining({ vendor: "jwplayer", kind: "script" }),
    ]);
    expect(detectPlayersInHtml("<script>var hls = new Hls();</script>")).toEqual([
      expect.objectContaining({ vendor: "hlsjs" }),
    ]);
  });

  it("resolves relative script sources against the page URL", () => {
    const players = detectPlayersInHtml(
      '<script src="/assets/hls.min.js"></script>',
      new URL("https://media.example/article"),
    );
    expect(players).toEqual([expect.objectContaining({ vendor: "hlsjs", kind: "script" })]);
  });

  it("ignores lookalike hosts and unrelated embeds", () => {
    expect(
      detectPlayersInHtml('<iframe src="https://not-rutube.ru/play/embed/1"></iframe>'),
    ).toEqual([]);
    expect(detectPlayersInHtml('<iframe src="https://maps.example/embed"></iframe>')).toEqual([]);
    expect(detectPlayersInHtml('<iframe src="javascript:alert(1)"></iframe>')).toEqual([]);
  });

  it("deduplicates by vendor over DOM sources and maps to contract players", () => {
    const detections = detectPlayersInSources({
      iframeUrls: ["https://www.youtube.com/embed/one", "https://www.youtube.com/embed/two"],
      scriptUrls: ["https://www.youtube.com/iframe_api"],
      videoTagCount: 2,
    });
    expect(detections).toHaveLength(2);
    expect(detections.map(({ vendor }) => vendor).sort()).toEqual(["html5-video", "youtube"]);
    expect(toRadarDetectedPlayers(detections, "rendered")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vendor: "youtube", via: "rendered", competitor: true }),
      ]),
    );
  });
});
