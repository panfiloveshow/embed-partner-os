import { describe, expect, it } from "vitest";
import type { RadarCandidate } from "@embed-os/contracts";
import type { RadarPort } from "../radar.port.js";
import type { CandidateSource, SourcedCandidate } from "./candidate-source.port.js";
import { normalizeCandidateHost } from "./domain-normalization.js";
import { RADAR_SOURCE_AUTO, RadarSourcingService } from "./radar-sourcing.service.js";
import type { SourcingDedupStore } from "./sourcing-store.js";

describe("normalizeCandidateHost", () => {
  it("normalizes to lowercase host without www, path or trailing dot", () => {
    expect(normalizeCandidateHost("https://WWW.Example.RU/news?page=2")).toBe("example.ru");
    expect(normalizeCandidateHost("example.ru")).toBe("example.ru");
    expect(normalizeCandidateHost("http://news.example.ru./video")).toBe("news.example.ru");
  });

  it("returns null for entries the Radar itself rejects", () => {
    expect(normalizeCandidateHost("not a url")).toBeNull();
    expect(normalizeCandidateHost("http://127.0.0.1/")).toBeNull();
    expect(normalizeCandidateHost("localhost")).toBeNull();
    expect(normalizeCandidateHost("ftp://example.ru")).toBeNull();
    expect(normalizeCandidateHost("https://cdn.example.ru")).toBeNull();
  });
});

interface RecordedCreate {
  input: { name: string; url: string; source: string };
  idempotencyKey: string;
}

function fakeRadar() {
  const creates: RecordedCreate[] = [];
  const inspections: Array<{ candidateId: string; idempotencyKey: string }> = [];
  const radar = {
    create(input: unknown, idempotencyKey: string) {
      const command = input as RecordedCreate["input"];
      creates.push({ input: command, idempotencyKey });
      return { id: `candidate-${creates.length}` } as RadarCandidate;
    },
    async requestInspection(candidateId: string, idempotencyKey: string) {
      inspections.push({ candidateId, idempotencyKey });
      return { id: candidateId } as RadarCandidate;
    },
  } as unknown as RadarPort;
  return { radar, creates, inspections };
}

function store(known: string[]): SourcingDedupStore {
  const set = new Set(known);
  return { isKnownDomain: async (host) => set.has(host) };
}

function source(id: string, candidates: SourcedCandidate[]): CandidateSource {
  return { id, fetchCandidates: async () => candidates };
}

describe("RadarSourcingService", () => {
  it("creates only unknown domains with source=auto and requests inspection", async () => {
    const { radar, creates, inspections } = fakeRadar();
    const service = new RadarSourcingService(
      [
        source("seed-list", [
          { siteName: "partner.ru", url: "https://partner.ru/" },
          { siteName: "candidate.ru", url: "https://candidate.ru/" },
          { siteName: "fresh.ru", url: "https://fresh.ru/" },
        ]),
      ],
      radar,
      store(["partner.ru", "candidate.ru"]),
    );

    const result = await service.runCycle();

    expect(result).toEqual({
      fetched: 3,
      created: 1,
      skippedDuplicates: 2,
      skippedInvalid: 0,
      failedSources: 0,
      failedCandidates: 0,
    });
    expect(creates).toEqual([
      {
        input: { name: "fresh.ru", url: "https://fresh.ru/", source: RADAR_SOURCE_AUTO },
        idempotencyKey: "sourcing:fresh.ru",
      },
    ]);
    expect(inspections).toEqual([
      { candidateId: "candidate-1", idempotencyKey: "sourcing:fresh.ru" },
    ]);
  });

  it("dedups by normalized domain within one cycle and skips invalid entries", async () => {
    const { radar, creates } = fakeRadar();
    const service = new RadarSourcingService(
      [
        source("seed-list", [
          { siteName: "media.ru", url: "https://WWW.Media.RU/section" },
          { siteName: "media.ru", url: "media.ru" },
          { siteName: "broken", url: "not a url" },
          { siteName: "ip", url: "http://10.0.0.1/" },
        ]),
      ],
      radar,
      store([]),
    );

    const result = await service.runCycle();

    expect(result.created).toBe(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.skippedInvalid).toBe(2);
    expect(creates.map(({ idempotencyKey }) => idempotencyKey)).toEqual(["sourcing:media.ru"]);
  });

  it("caps new candidates per cycle and survives a failing source", async () => {
    const { radar, creates } = fakeRadar();
    const failing: CandidateSource = {
      id: "broken-source",
      fetchCandidates: async () => {
        throw new Error("network down");
      },
    };
    const many = Array.from({ length: 5 }, (_, index) => ({
      siteName: `site-${index}.ru`,
      url: `https://site-${index}.ru/`,
    }));
    const service = new RadarSourcingService(
      [failing, source("seed-list", many)],
      radar,
      store([]),
      2,
    );

    const result = await service.runCycle();

    expect(result.failedSources).toBe(1);
    expect(result.created).toBe(2);
    expect(creates).toHaveLength(2);
  });

  it("counts a create failure without aborting the cycle", async () => {
    const { radar, creates } = fakeRadar();
    const originalCreate = radar.create.bind(radar);
    radar.create = ((input: unknown, key: string) => {
      if (key === "sourcing:bad.ru") throw new Error("boom");
      return originalCreate(input, key);
    }) as RadarPort["create"];
    const service = new RadarSourcingService(
      [
        source("seed-list", [
          { siteName: "bad.ru", url: "https://bad.ru/" },
          { siteName: "good.ru", url: "https://good.ru/" },
        ]),
      ],
      radar,
      store([]),
    );

    const result = await service.runCycle();

    expect(result.failedCandidates).toBe(1);
    expect(result.created).toBe(1);
    expect(creates.map(({ input }) => input.name)).toEqual(["good.ru"]);
  });
});
