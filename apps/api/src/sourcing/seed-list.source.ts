import { readFile } from "node:fs/promises";
import type { CandidateSource, SourcedCandidate } from "./candidate-source.port.js";

export const SEED_LIST_SOURCE_ID = "seed-list";

const MAX_SEED_ENTRIES = 10_000;

/**
 * Parses an operator-provided seed list: one domain or URL per line, blank
 * lines and `#` comments ignored. This is the channel for РКН media registry
 * exports and LiveInternet/Mediascope tops — see docs/runbooks/radar.md.
 */
export function parseSeedList(text: string): SourcedCandidate[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, MAX_SEED_ENTRIES)
    .map(seedEntry);
}

function seedEntry(entry: string): SourcedCandidate {
  const withoutProtocol = entry.replace(/^https?:\/\//i, "");
  const siteName = withoutProtocol.split(/[/?#]/, 1)[0] ?? withoutProtocol;
  return { siteName, url: entry, note: "из seed-списка оператора" };
}

/**
 * Reads seed domains from `RADAR_SOURCING_SEED_URLS` (comma-separated) and/or
 * the file named by `RADAR_SOURCING_SEED_FILE` (plain text, one entry per
 * line). Both inputs are re-read on every cycle, so the operator can drop a
 * new file without restarting the worker.
 */
export class SeedListCandidateSource implements CandidateSource {
  readonly id = SEED_LIST_SOURCE_ID;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly readTextFile: (path: string) => Promise<string> = (path) =>
      readFile(path, "utf8"),
  ) {}

  async fetchCandidates(): Promise<SourcedCandidate[]> {
    const inline = (this.env.RADAR_SOURCING_SEED_URLS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map(seedEntry);
    const filePath = this.env.RADAR_SOURCING_SEED_FILE?.trim();
    let fromFile: SourcedCandidate[] = [];
    if (filePath) {
      try {
        fromFile = parseSeedList(await this.readTextFile(filePath));
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "radar-sourcing.seed-file-unreadable",
            filePath,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return [...inline, ...fromFile];
  }
}
