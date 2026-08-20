import type { PlayerDetection } from "./player-signatures.js";

export const RADAR_PAGE_RENDERER = Symbol("RADAR_PAGE_RENDERER");

export interface RenderedPageObservation {
  url: string;
  ok: boolean;
  players: PlayerDetection[];
  error?: string;
}

export interface RenderOptions {
  /** Hard cap on pages rendered per call (the adapter enforces its own cap too). */
  maxPages?: number;
  /** Per-page navigation timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * L1 check: renders pages in a headless browser and reports the video players
 * found in the live DOM. Implementations must skip gracefully (return an empty
 * array) when no browser is available.
 */
export interface RadarPageRenderer {
  render(urls: string[], options?: RenderOptions): Promise<RenderedPageObservation[]>;
}
