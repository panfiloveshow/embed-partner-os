import { describe, expect, it } from "vitest";
import type { RadarResearch } from "@embed-os/contracts";
import {
  enrichResearchWithLegalEntity,
  extractInn,
  extractOgrn,
  extractRequisites,
  fetchDirectorLead,
  fetchEgrulCard,
  regionFromEgrulAddress,
} from "./legal-entity-enrichment.js";

function researchFixture(): RadarResearch {
  return {
    method: "html-signals-v1",
    pageUrl: "https://plati.market/",
    collectedAt: "2026-08-25T09:00:00.000Z",
    signals: [],
    contacts: [],
    decisionMakers: [],
    videoPages: [],
    brief: {
      readiness: "new",
      siteSummary: "",
      videoUsage: "",
      rutubeUseCase: "",
      likelyContactRoles: [],
      risks: [],
      nextAction: "",
      whyNow: "",
      priorityInsights: [],
      opportunityPotential: {
        minDailyVisits: null,
        maxDailyVisits: null,
        observedVideoSharePercent: 0,
        minMonthlyVideoOpportunities: null,
        maxMonthlyVideoOpportunities: null,
        basis: "",
        confidence: "medium",
      },
      outreach: {
        targetName: null,
        targetRole: null,
        channel: "contact_page",
        destination: "",
        subject: "",
        messageDraft: "",
      },
    },
    notes: [],
    legalInn: "7707083893",
  };
}

describe("извлечение реквизитов из HTML", () => {
  it("ИНН юрлица и ОГРН из текста реквизитов", () => {
    const html = `<p>ООО «Пример». ИНН: 7707083893, ОГРН 1027700132195.</p>`;
    expect(extractInn(html)).toBe("7707083893");
    expect(extractOgrn(html)).toBe("1027700132195");
    expect(extractRequisites(html).inn).toBe("7707083893");
  });

  it("ИНН ИП из 12 цифр; без реквизитов -> null", () => {
    expect(extractInn("<span>ИНН 770123456789</span>")).toBe("770123456789");
    expect(extractInn("<p>Контакты без реквизитов</p>")).toBeNull();
    expect(extractOgrn("<p>нет</p>")).toBeNull();
  });
});

describe("регион из адреса ЕГРЮЛ", () => {
  it("города федерального значения (в разных форматах ФНС)", () => {
    expect(regionFromEgrulAddress("115191, ГОРОД МОСКВА, УЛИЦА ТВЕРСКАЯ")).toBe("г. Москва");
    expect(regionFromEgrulAddress("г Москва, ул Тверская")).toBe("г. Москва");
    expect(regionFromEgrulAddress("191186, Г САНКТ-ПЕТЕРБУРГ, НЕВСКИЙ ПР, Д 30")).toBe(
      "г. Санкт-Петербург",
    );
  });

  it("области и республики с родовыми словами со строчной", () => {
    expect(regionFromEgrulAddress("620014, СВЕРДЛОВСКАЯ ОБЛ, Г ЕКАТЕРИНБУРГ")).toBe(
      "Свердловская область",
    );
    expect(regionFromEgrulAddress("420111, РЕСП ТАТАРСТАН, Г КАЗАНЬ")).toBe(
      "Республика Татарстан",
    );
    expect(regionFromEgrulAddress("344002, РОСТОВСКАЯ ОБЛ")).toBe("Ростовская область");
  });

  it("нераспознаваемый или пустой адрес -> null", () => {
    expect(regionFromEgrulAddress(null)).toBeNull();
    expect(regionFromEgrulAddress("")).toBeNull();
    expect(regionFromEgrulAddress(", ,")).toBeNull();
  });
});

describe("ЕГРЮЛ (ФНС) quick-card", () => {
  const tokenResponse = () =>
    new Response(JSON.stringify({ t: "TOKEN123", captchaRequired: false }), { status: 200 });
  const rowsResponse = () =>
    new Response(
      JSON.stringify({
        rows: [
          {
            c: 'ООО "ПЛАТИ МАРКЕТ"',
            n: "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ \"ПЛАТИ МАРКЕТ\"",
            g: "ГЕНЕРАЛЬНЫЙ ДИРЕКТОР: Смирнов Евгений Евгеньевич",
            i: "7707083893",
            o: "1027700132195",
            a: "г Москва, ул Тверская",
          },
        ],
      }),
      { status: 200 },
    );

  it("двухшаговый флоу: POST -> токен -> rows с реквизитами и директором", async () => {
    const urls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return url.includes("search-result") ? rowsResponse() : tokenResponse();
    };
    const result = await fetchEgrulCard("7707083893", 5000, fetcher);
    expect(urls[0]).toBe("https://egrul.nalog.ru/");
    expect(urls[1]).toContain("https://egrul.nalog.ru/search-result/TOKEN123");
    expect(result?.card.fullName).toBe('ООО "ПЛАТИ МАРКЕТ"');
    expect(result?.card.ogrn).toBe("1027700132195");
    expect(result?.card.region).toBe("г. Москва");
    expect(result?.director?.fullName).toBe("Смирнов Евгений Евгеньевич");
    expect(result?.director?.role).toBe("ГЕНЕРАЛЬНЫЙ ДИРЕКТОР");
    expect(result?.director?.confidence).toBe("high");
  });

  it("ИП: ФИО из названия записи -> директор, роль ИП", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("search-result")
        ? new Response(
            JSON.stringify({
              rows: [
                {
                  k: "ip",
                  n: "ИП Смирнов Евгений Евгеньевич",
                  i: "770123456789",
                  o: "309774612345678",
                },
              ],
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ t: "TOK" }), { status: 200 });
    };
    const result = await fetchEgrulCard("770123456789", 5000, fetcher);
    expect(result?.director?.fullName).toBe("Смирнов Евгений Евгеньевич");
    expect(result?.director?.role).toBe("Индивидуальный предприниматель");
    expect(result?.card.fullName).toBe("ИП Смирнов Евгений Евгеньевич");
  });

  it("регион из короткого поля rn (когда адреса a нет)", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("search-result")
        ? new Response(
            JSON.stringify({
              rows: [
                {
                  c: 'ООО "ВЕБМАНИ.РУ"',
                  g: "ГЕНЕРАЛЬНЫЙ ДИРЕКТОР: Смирнов Евгений Евгеньевич",
                  i: "7718790862",
                  k: "ul",
                  o: "1097746855502",
                  rn: "Г.Москва",
                },
              ],
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ t: "TOK" }), { status: 200 });
    };
    const result = await fetchEgrulCard("7718790862", 5000, fetcher);
    expect(result?.card.region).toBe("г. Москва");
    expect(result?.card.address).toBeNull();
  });

  it("сбой сервиса -> null, а не исключение", async () => {
    const fetcher = async () => new Response("err", { status: 500 });
    await expect(fetchEgrulCard("7707083893", 1000, fetcher)).resolves.toBeNull();
  });
});

describe("DaData: директор как ЛПР", () => {
  it("management -> lead с высоким confidence", async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          suggestions: [
            {
              data: {
                management: {
                  name: "Зубарев Данил Викторович",
                  post: "ГЕНЕРАЛЬНЫЙ ДИРЕКТОР",
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    const lead = await fetchDirectorLead(
      "7707083893",
      "test-key",
      "https://plati.market/",
      5000,
      fetcher,
    );
    expect(lead?.fullName).toBe("Зубарев Данил Викторович");
    expect(lead?.role).toBe("ГЕНЕРАЛЬНЫЙ ДИРЕКТОР");
    expect(lead?.confidence).toBe("high");
    expect(lead?.evidence).toContain("ЕГРЮЛ");
  });
});

describe("enrichResearchWithLegalEntity", () => {
  it("добавляет директора первым в decisionMakers + карточку юрлица", async () => {
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("dadata")) {
        return new Response(
          JSON.stringify({
            suggestions: [
              { data: { management: { name: "Директор Директорович", post: "ГЕН ДИРЕКТОР" } } },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("search-result")) {
        return new Response(
          JSON.stringify({
            rows: [
              {
                c: "ООО ТЕСТ",
                n: "ООО ТЕСТ",
                g: "ГЕНЕРАЛЬНЫЙ ДИРЕКТОР: Директор Директорович",
                i: "7707083893",
                a: "115191, ГОРОД МОСКВА, УЛ ТВЕРСКАЯ, Д 1",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ t: "TOK" }), { status: 200 });
    };
    const enriched = await enrichResearchWithLegalEntity(
      researchFixture(),
      { dadataApiKey: "key" },
      fetcher,
    );
    expect(calls.some((url) => url.includes("dadata"))).toBe(false);
    expect(enriched.decisionMakers[0]?.fullName).toBe("Директор Директорович");
    expect(enriched.legalEntity?.fullName).toBe("ООО ТЕСТ");
    expect(enriched.legalInn).toBe("7707083893");
    // Регион ФНС -> research.legalRegion + сигнал географии (полный вес фактора).
    expect(enriched.legalRegion).toBe("г. Москва");
    const geography = enriched.signals.find(({ field }) => field === "geography");
    expect(geography?.value).toBe("г. Москва, Россия");
    expect(geography?.source).toContain("ЕГРЮЛ");
    expect(geography?.confidence).toBe("high");
  });

  it("без ИНН исследование не меняется и запросов нет", async () => {
    const base = researchFixture();
    const noInn = { ...base, legalInn: null };
    let called = 0;
    const fetcher = async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    };
    const result = await enrichResearchWithLegalEntity(noInn, { dadataApiKey: "k" }, fetcher);
    expect(called).toBe(0);
    expect(result).toEqual(noInn);
  });

  it("падение обоих источников -> research без изменений (без исключений)", async () => {
    const fetcher = async () => new Response("{}", { status: 500 });
    const base = researchFixture();
    const result = await enrichResearchWithLegalEntity(base, { dadataApiKey: "k" }, fetcher);
    expect(result.legalEntity).toBeNull();
    expect(result.decisionMakers).toEqual([]);
  });
});
