import { describe, expect, it } from "vitest";
import { parseSeedList, SeedListCandidateSource } from "./seed-list.source.js";

describe("parseSeedList", () => {
  it("parses one domain or URL per line, ignoring blanks and comments", () => {
    const parsed = parseSeedList(
      [
        "# реестр СМИ РКН, выгрузка 2026-08",
        "",
        "vesti-region.ru",
        "  https://sport-online.ru/video  ",
        "новости.рф",
      ].join("\n"),
    );
    expect(parsed.map(({ url }) => url)).toEqual([
      "vesti-region.ru",
      "https://sport-online.ru/video",
      "новости.рф",
    ]);
    expect(parsed.map(({ siteName }) => siteName)).toEqual([
      "vesti-region.ru",
      "sport-online.ru",
      "новости.рф",
    ]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseSeedList("")).toEqual([]);
    expect(parseSeedList("\n# only comments\n\n")).toEqual([]);
  });
});

describe("SeedListCandidateSource", () => {
  it("combines RADAR_SOURCING_SEED_URLS and the seed file", async () => {
    const seedSource = new SeedListCandidateSource(
      {
        RADAR_SOURCING_SEED_URLS: " one.ru , https://two.ru/page ,",
        RADAR_SOURCING_SEED_FILE: "/tmp/seed.txt",
      },
      async () => "three.ru\n#skip\nfour.ru\n",
    );
    const candidates = await seedSource.fetchCandidates();
    expect(candidates.map(({ url }) => url)).toEqual([
      "one.ru",
      "https://two.ru/page",
      "three.ru",
      "four.ru",
    ]);
  });

  it("keeps inline entries when the seed file is unreadable", async () => {
    const seedSource = new SeedListCandidateSource(
      { RADAR_SOURCING_SEED_URLS: "one.ru", RADAR_SOURCING_SEED_FILE: "/missing.txt" },
      async () => {
        throw new Error("ENOENT");
      },
    );
    const candidates = await seedSource.fetchCandidates();
    expect(candidates.map(({ url }) => url)).toEqual(["one.ru"]);
  });

  it("returns nothing when no configuration is set", async () => {
    const seedSource = new SeedListCandidateSource({}, async () => "unused.ru");
    expect(await seedSource.fetchCandidates()).toEqual([]);
  });
});
