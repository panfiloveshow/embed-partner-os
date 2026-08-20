import type { RadarDetectedPlayer } from "@embed-os/contracts";

/**
 * Catalog of video player signatures.
 *
 * Two consumers share it:
 * - L0: the static-HTML feature extraction path (detectPlayersInHtml);
 * - L1: the headless renderer, which collects iframe/script sources and
 *   `<video>` tags from the live DOM and runs them through
 *   detectPlayersInSources.
 *
 * `competitor: true` marks third-party video hostings (proven demand for a
 * migration pitch). RUTUBE itself and generic self-hosted players
 * (JW Player, Video.js, hls.js, native `<video>`) are not competitors.
 */

export type PlayerDetectionKind = "iframe" | "script" | "video-tag";

export interface PlayerDetection {
  vendor: string;
  label: string;
  competitor: boolean;
  kind: PlayerDetectionKind;
  sampleUrl?: string;
}

export interface PlayerSourceSample {
  /** Absolute or protocol-relative URLs of iframe embeds found on the page. */
  iframeUrls: string[];
  /** Absolute or protocol-relative URLs of loaded scripts. */
  scriptUrls: string[];
  /** Number of native `<video>` elements. */
  videoTagCount: number;
  /** Raw HTML (optional) for inline fingerprints such as `videojs(...)`. */
  html?: string;
}

interface PlayerSignature {
  vendor: string;
  label: string;
  competitor: boolean;
  /** Matches an embed iframe URL (hostname already lowercased). */
  iframe?: (url: URL) => boolean;
  /** Matches a player script URL (hostname already lowercased). */
  script?: (url: URL) => boolean;
  /** Matches inline usage in raw HTML (class names, constructor calls). */
  html?: RegExp;
}

const hostMatches = (hostname: string, domain: string) =>
  hostname === domain || hostname.endsWith(`.${domain}`);

const PLAYER_SIGNATURES: PlayerSignature[] = [
  {
    vendor: "rutube",
    label: "RUTUBE",
    competitor: false,
    iframe: (url) =>
      hostMatches(url.hostname, "rutube.ru") && /^\/play\/embed\//.test(url.pathname),
  },
  {
    vendor: "vk",
    label: "VK Видео",
    competitor: true,
    iframe: (url) =>
      (hostMatches(url.hostname, "vk.com") && /^\/video_ext(?:\.php)?/.test(url.pathname)) ||
      (hostMatches(url.hostname, "vkvideo.ru") && /^\/(?:video_ext|embed)/.test(url.pathname)),
    script: (url) => hostMatches(url.hostname, "vk.com") && /videoplayer/i.test(url.pathname),
  },
  {
    vendor: "youtube",
    label: "YouTube",
    competitor: true,
    iframe: (url) =>
      (hostMatches(url.hostname, "youtube.com") ||
        hostMatches(url.hostname, "youtube-nocookie.com")) &&
      /^\/embed\//.test(url.pathname),
    script: (url) =>
      hostMatches(url.hostname, "youtube.com") && /iframe_api|player_api/i.test(url.pathname),
  },
  {
    vendor: "kinescope",
    label: "Kinescope",
    competitor: true,
    iframe: (url) => hostMatches(url.hostname, "kinescope.io"),
    script: (url) => hostMatches(url.hostname, "kinescope.io"),
  },
  {
    vendor: "ok",
    label: "OK Видео",
    competitor: true,
    iframe: (url) => hostMatches(url.hostname, "ok.ru") && /^\/videoembed\//.test(url.pathname),
  },
  {
    vendor: "dzen",
    label: "Дзен",
    competitor: true,
    iframe: (url) => hostMatches(url.hostname, "dzen.ru") && /embed/i.test(url.pathname),
  },
  {
    vendor: "smotrim",
    label: "Смотрим / ВГТРК",
    competitor: true,
    iframe: (url) =>
      (hostMatches(url.hostname, "smotrim.ru") && /video|embed|iframe/i.test(url.pathname)) ||
      (hostMatches(url.hostname, "vgtrk.com") && /video|embed|iframe/i.test(url.pathname)),
  },
  {
    vendor: "vimeo",
    label: "Vimeo",
    competitor: true,
    iframe: (url) => url.hostname === "player.vimeo.com" && /^\/video\//.test(url.pathname),
  },
  {
    vendor: "jwplayer",
    label: "JW Player",
    competitor: false,
    script: (url) =>
      hostMatches(url.hostname, "jwplayer.com") ||
      hostMatches(url.hostname, "jwplatform.com") ||
      hostMatches(url.hostname, "jwpcdn.com") ||
      /\bjwplayer[^/]*\.js/i.test(url.pathname),
    html: /\bjwplayer\s*\(/i,
  },
  {
    vendor: "videojs",
    label: "Video.js",
    competitor: false,
    script: (url) =>
      hostMatches(url.hostname, "vjs.zencdn.net") || /\bvideo(?:\.min)?\.js$/i.test(url.pathname),
    html: /\bvideo-js\b|\bvideojs\s*\(/i,
  },
  {
    vendor: "hlsjs",
    label: "hls.js",
    competitor: false,
    script: (url) => /\bhls(?:\.min|\.light(?:\.min)?)?\.js$/i.test(url.pathname),
    html: /\bnew\s+Hls\s*\(/,
  },
  {
    vendor: "html5-video",
    label: "HTML5 <video>",
    competitor: false,
    // Matched through videoTagCount / raw HTML, not through URLs.
    html: /<video\b/i,
  },
];

export function playerSignatureLabel(vendor: string): string {
  return PLAYER_SIGNATURES.find((signature) => signature.vendor === vendor)?.label ?? vendor;
}

/**
 * Runs the catalog over pre-collected page sources (used by the headless
 * renderer, where the DOM is the source of truth).
 */
export function detectPlayersInSources(sample: PlayerSourceSample): PlayerDetection[] {
  const detections = new Map<string, PlayerDetection>();
  const add = (signature: PlayerSignature, kind: PlayerDetectionKind, sampleUrl?: string) => {
    if (detections.has(signature.vendor)) return;
    detections.set(signature.vendor, {
      vendor: signature.vendor,
      label: signature.label,
      competitor: signature.competitor,
      kind,
      ...(sampleUrl ? { sampleUrl } : {}),
    });
  };

  for (const raw of sample.iframeUrls) {
    const url = parsePlayerUrl(raw);
    if (!url) continue;
    for (const signature of PLAYER_SIGNATURES) {
      if (signature.iframe?.(url)) add(signature, "iframe", url.toString());
    }
  }
  for (const raw of sample.scriptUrls) {
    const url = parsePlayerUrl(raw);
    if (!url) continue;
    for (const signature of PLAYER_SIGNATURES) {
      if (signature.script?.(url)) add(signature, "script", url.toString());
    }
  }
  if (sample.html) {
    for (const signature of PLAYER_SIGNATURES) {
      if (signature.vendor === "html5-video") continue;
      if (signature.html?.test(sample.html)) add(signature, "script");
    }
  }
  if (sample.videoTagCount > 0 || (sample.html && /<video\b/i.test(sample.html))) {
    const native = PLAYER_SIGNATURES.find(({ vendor }) => vendor === "html5-video")!;
    add(native, "video-tag");
  }
  return [...detections.values()];
}

/** Runs the catalog over static HTML (L0 path). */
export function detectPlayersInHtml(html: string, baseUrl?: URL): PlayerDetection[] {
  const resolve = (raw: string) => {
    if (!baseUrl || /^(?:https?:)?\/\//i.test(raw)) return raw;
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return raw;
    }
  };
  return detectPlayersInSources({
    iframeUrls: tagSources(html, "iframe").map(resolve),
    scriptUrls: tagSources(html, "script").map(resolve),
    videoTagCount: /<video\b/i.test(html) ? 1 : 0,
    html,
  });
}

export function toRadarDetectedPlayers(
  detections: PlayerDetection[],
  via: "static" | "rendered",
): RadarDetectedPlayer[] {
  return detections.map((detection) => ({
    vendor: detection.vendor,
    label: detection.label,
    competitor: detection.competitor,
    via,
    sampleUrl: detection.sampleUrl ?? null,
  }));
}

function tagSources(html: string, tag: string): string[] {
  const sources: string[] = [];
  for (const match of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))) {
    const source = match[0].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const raw = (source?.[1] ?? source?.[2] ?? source?.[3])?.replace(/&amp;/gi, "&");
    if (raw) sources.push(raw);
  }
  return sources;
}

function parsePlayerUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    return url;
  } catch {
    return null;
  }
}
