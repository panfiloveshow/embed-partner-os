import type {
  RadarCandidateFeatures,
  RadarContactLead,
  RadarConfidence,
  RadarDecisionMakerLead,
  RadarDetectedPlayer,
  RadarFeatureSignal,
  RadarResearch,
  RadarResearchField,
  RadarTrafficEstimate,
  RadarVideoPageLead,
  RadarWorkBrief,
  RadarResearchCoverage,
  RadarPriorityInsight,
  RadarOpportunityPotential,
  RadarOutreachPackage,
  RadarChangeSignal,
} from "@embed-os/contracts";
import { extractRequisites } from "./legal-entity-enrichment.js";

export interface RadarPageFeatureExtraction {
  features: Partial<RadarCandidateFeatures>;
  research: RadarResearch;
}

type SignalInput = Omit<RadarFeatureSignal, "field">;

export function extractRadarPageFeatures(
  html: string,
  pageUrl: URL,
  collectedAt: Date = new Date(),
): RadarPageFeatureExtraction {
  const features: Partial<RadarCandidateFeatures> = {};
  const signals: RadarFeatureSignal[] = [];
  const add = <T extends RadarResearchField>(field: T, input: SignalInput) => {
    signals.push({ field, ...input });
  };
  const title = firstTagText(html, "title");
  const description = metaContent(html, "description") ?? metaContent(html, "og:description");
  const summary = compactText(
    [title, metaContent(html, "og:title"), description].filter(Boolean).join(" "),
  );

  const language = htmlAttribute(html, "lang")?.split(/[-_]/, 1)[0]?.toLocaleLowerCase("en-US");
  if (language && /^[a-z]{2,3}$/.test(language)) {
    features.language = language;
    add("language", signal("Язык", language, "атрибут html[lang]", "high"));
  }

  const topic = detectTopic(html, summary);
  if (topic) {
    features.topic = topic.value;
    add("topic", signal("Тематика", topic.value, topic.source, topic.confidence));
  }

  const geography = detectGeography(html, summary);
  if (geography) {
    features.geography = geography.value;
    add("geography", signal("География", geography.value, geography.source, geography.confidence));
  }

  const publicationFrequency = detectPublicationFrequency(html);
  if (publicationFrequency) {
    features.publicationFrequency = publicationFrequency.value;
    add(
      "publicationFrequency",
      signal(
        "Частота публикаций",
        frequencyLabel(publicationFrequency.value),
        `${publicationFrequency.count} дат публикаций на странице`,
        publicationFrequency.confidence,
      ),
    );
  }

  const contacts = detectContacts(html, pageUrl);
  const decisionMakers = detectDecisionMakers(html, pageUrl);
  if (contacts.length > 0) {
    features.contactsFound = true;
    const direct = contacts.filter(({ type }) => type !== "contact_page").length;
    add(
      "contactsFound",
      signal(
        "Контакты",
        "Найдены",
        direct > 0 ? `${direct} публичных каналов связи` : "страница контактов",
        direct > 0 ? "high" : "medium",
      ),
    );
  }

  const cms = detectCms(html);
  if (cms) {
    features.cms = cms.value;
    add("cms", signal("CMS / технология", cms.value, cms.source, cms.confidence));
  }

  const videoPages = detectVideoPageLinks(html, pageUrl);
  if (videoPages.length > 0) {
    features.estimatedVideoPagesMin = videoPages.length;
    features.estimatedVideoPagesMax = videoPages.length;
    add(
      "estimatedVideoPages",
      signal(
        "Страницы с видео",
        String(videoPages.length),
        "уникальные видеоссылки на проверенной странице",
        "low",
      ),
    );
  }

  // Реквизиты (ИНН/ОГРН) — вход для обогащения через ЕГРЮЛ/ФНС.
  const requisites = extractRequisites(html);

  const brief = buildWorkBrief(features, contacts, decisionMakers, videoPages, pageUrl);

  return {
    features,
    research: {
      method: "html-signals-v1",
      pageUrl: pageUrl.toString(),
      collectedAt: collectedAt.toISOString(),
      signals,
      contacts,
      decisionMakers,
      videoPages,
      brief,
      legalInn: requisites.inn,
      legalOgrn: requisites.ogrn,
      notes: [
        "Собраны только признаки, доступные в переданном публичном HTML.",
        "Трафик не оценивается без подключённого внешнего провайдера.",
      ],
    },
  };
}

export function findRadarResearchLinks(html: string, pageUrl: URL, limit = 3) {
  const candidates = anchorLinks(html, pageUrl).flatMap((link) => {
    if (!link.url || link.url.origin !== pageUrl.origin || !/^https?:$/.test(link.url.protocol))
      return [];
    const haystack = `${link.url.pathname} ${link.label}`.toLocaleLowerCase("ru-RU");
    const score = researchLinkScore(haystack);
    if (score === 0) return [];
    link.url.hash = "";
    return [{ url: link.url.toString(), score }];
  });
  const unique = new Map<string, number>();
  for (const candidate of candidates) {
    unique.set(candidate.url, Math.max(unique.get(candidate.url) ?? 0, candidate.score));
  }
  return [...unique.entries()]
    .map(([url, score]) => ({ url, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, limit))
    .map(({ url }) => url);
}

export function mergeRadarPageExtractions(
  extractions: RadarPageFeatureExtraction[],
  trafficEstimate?: RadarTrafficEstimate | null,
  coverage?: RadarResearchCoverage,
  extraVideoPages: RadarVideoPageLead[] = [],
): RadarPageFeatureExtraction {
  const primary = extractions[0];
  if (!primary) throw new Error("At least one radar page extraction is required");
  const features = extractions.reduce<Partial<RadarCandidateFeatures>>(
    (current, extraction) => ({
      topic: current.topic ?? extraction.features.topic,
      language: current.language ?? extraction.features.language,
      geography: current.geography ?? extraction.features.geography,
      publicationFrequency:
        current.publicationFrequency && current.publicationFrequency !== "unknown"
          ? current.publicationFrequency
          : extraction.features.publicationFrequency,
      contactsFound: current.contactsFound === true || extraction.features.contactsFound === true,
      cms: current.cms ?? extraction.features.cms,
      estimatedVideoPagesMin:
        Math.max(
          current.estimatedVideoPagesMin ?? 0,
          extraction.features.estimatedVideoPagesMin ?? 0,
        ) || undefined,
      estimatedVideoPagesMax:
        Math.max(
          current.estimatedVideoPagesMax ?? 0,
          extraction.features.estimatedVideoPagesMax ?? 0,
        ) || undefined,
      trafficEstimate:
        trafficEstimate ?? current.trafficEstimate ?? extraction.features.trafficEstimate,
    }),
    {},
  );
  const contacts = uniqueBy(
    extractions.flatMap(({ research }) => research.contacts),
    (lead) => `${lead.type}:${lead.href}`,
  );
  const decisionMakers = mergeDecisionMakers(
    extractions.flatMap(({ research }) => research.decisionMakers),
  );
  const videoPages = uniqueBy(
    [...extractions.flatMap(({ research }) => research.videoPages), ...extraVideoPages],
    ({ pageUrl }) => pageUrl,
  );
  // Sitemap-видеостраницы расширяют верхнюю границу оценки объёма видео
  // (нижняя граница остаётся равной числу реально проверенных страниц).
  if (videoPages.length > (features.estimatedVideoPagesMax ?? 0))
    features.estimatedVideoPagesMax = videoPages.length;
  const signals = uniqueBy(
    extractions.flatMap(({ research }) => research.signals),
    ({ field }) => field,
  );
  const pageUrl = new URL(primary.research.pageUrl);
  // Реквизиты: первый непустой ИНН/ОГРН среди всех проверенных страниц.
  const legalInn =
    extractions.map(({ research }) => research.legalInn).find((inn) => Boolean(inn)) ?? null;
  const legalOgrn =
    extractions.map(({ research }) => research.legalOgrn).find((ogrn) => Boolean(ogrn)) ?? null;
  const notes = uniqueBy(
    extractions.flatMap(({ research }) => research.notes),
    (note) => note,
  ).filter((note) => !trafficEstimate || !note.startsWith("Трафик не оценивается"));
  if (extractions.length > 1)
    notes.push(`Дополнительно проверено внутренних страниц: ${extractions.length - 1}.`);
  if (trafficEstimate)
    notes.push(
      `Посещаемость получена через ${trafficEstimate.provider}; это внешняя оценка, а не данные счётчика сайта.`,
    );
  return {
    features,
    research: {
      ...primary.research,
      method: coverage ? "site-intelligence-v2" : primary.research.method,
      signals,
      contacts,
      decisionMakers,
      videoPages,
      brief: buildWorkBrief(features, contacts, decisionMakers, videoPages, pageUrl, coverage),
      legalInn,
      legalOgrn,
      notes,
      ...(coverage ? { coverage } : {}),
    },
  };
}

/**
 * Регион юрлица из официального адреса ЕГРЮЛ — самый надёжный источник
 * географии. Если пользователь не указал географию вручную и Радар не нашёл
 * её в метаданных, подставляем регион ФНС в факторы скоринга (значение вида
 * «г. Москва, Россия» даёт полный вес фактора «Целевая география»).
 */
export function applyLegalRegionToGeography(
  extraction: RadarPageFeatureExtraction,
): RadarPageFeatureExtraction {
  const region = extraction.research.legalRegion?.trim();
  if (!region || extraction.features.geography) return extraction;
  return {
    ...extraction,
    features: { ...extraction.features, geography: `${region}, Россия` },
  };
}

/**
 * Injects the "player already in use" evidence into the work brief. A detected
 * competitor embed is proven demand, so it leads the "why now" story and the
 * dossier proposes a migration scenario to the RUTUBE player.
 */
export function enrichRadarResearchWithDetectedPlayers(
  extraction: RadarPageFeatureExtraction,
  detectedPlayers: RadarDetectedPlayer[],
): RadarPageFeatureExtraction {
  if (detectedPlayers.length === 0) return extraction;
  const labels = [...new Set(detectedPlayers.map(({ label }) => label))];
  const competitors = [
    ...new Set(detectedPlayers.filter(({ competitor }) => competitor).map(({ label }) => label)),
  ];
  const insight: RadarPriorityInsight =
    competitors.length > 0
      ? {
          code: "player",
          label: "Уже использует сторонний видеохостинг",
          explanation: `Сайт уже встраивает ${competitors.join(", ")} — сценарий миграции на RUTUBE-плеер.`,
          confidence: "high",
        }
      : {
          code: "player",
          label: "Видеоплеер подтверждён",
          explanation: `На страницах найден видеоплеер: ${labels.join(", ")}.`,
          confidence: "medium",
        };
  const brief = extraction.research.brief;
  const priorityInsights = [
    insight,
    ...(brief.priorityInsights ?? []).filter(({ code }) => code !== "player"),
  ];
  const videoUsage = brief.videoUsage.startsWith("На переданной странице не найдено")
    ? `Подтверждён видеоплеер (${labels.join(", ")}) — сценарий уже работает на стороне площадки.`
    : brief.videoUsage;
  return {
    ...extraction,
    research: {
      ...extraction.research,
      brief: {
        ...brief,
        priorityInsights,
        videoUsage,
        whyNow: priorityInsights
          .slice(0, 3)
          .map(({ explanation }) => explanation)
          .join(" "),
      },
    },
  };
}

export function enrichRadarResearchWithChanges(
  previous: RadarResearch | null,
  current: RadarResearch,
): RadarResearch {
  if (!previous) return current;
  const detectedAt = current.collectedAt;
  const changes: RadarChangeSignal[] = [];
  const previousPeople = new Set(previous.decisionMakers.map(decisionMakerKey));
  const newPeople = current.decisionMakers.filter(
    (person) => !previousPeople.has(decisionMakerKey(person)),
  );
  if (newPeople.length > 0) {
    changes.push({
      code: "new_lpr",
      label: "Новый ЛПР",
      explanation: `Найдены новые целевые контакты: ${newPeople
        .slice(0, 2)
        .map(({ fullName, role }) => fullName ?? role)
        .join(", ")}.`,
      detectedAt,
      confidence: newPeople.some(({ confidence }) => confidence === "high") ? "high" : "medium",
    });
  }
  const previousChannels = new Set(previous.contacts.map(({ type, value }) => `${type}:${value}`));
  const newChannels = current.contacts.filter(
    ({ type, value }) => !previousChannels.has(`${type}:${value}`),
  );
  if (newChannels.length > 0) {
    changes.push({
      code: "new_contact",
      label: "Новый канал связи",
      explanation: `Появились новые публичные каналы: ${newChannels
        .slice(0, 2)
        .map(({ value }) => value)
        .join(", ")}.`,
      detectedAt,
      confidence: newChannels.some(({ confidence }) => confidence === "high") ? "high" : "medium",
    });
  }
  const previousTraffic = previous.brief.opportunityPotential?.maxDailyVisits;
  const currentTraffic = current.brief.opportunityPotential?.maxDailyVisits;
  if (previousTraffic && currentTraffic && currentTraffic >= previousTraffic * 1.25) {
    changes.push({
      code: "traffic_growth",
      label: "Рост аудитории",
      explanation: `Верхняя оценка дневной аудитории выросла с ${formatNumber(previousTraffic)} до ${formatNumber(currentTraffic)}.`,
      detectedAt,
      confidence: current.brief.opportunityPotential?.confidence ?? "medium",
    });
  }
  const previousVideos = previous.coverage?.videoPagesObserved ?? previous.videoPages.length;
  const currentVideos = current.coverage?.videoPagesObserved ?? current.videoPages.length;
  if (currentVideos > previousVideos) {
    changes.push({
      code: "video_growth",
      label: "Новые видеостраницы",
      explanation: `Количество подтверждённых видеостраниц выросло с ${previousVideos} до ${currentVideos}.`,
      detectedAt,
      confidence: "medium",
    });
  }
  if (changes.length === 0) {
    changes.push({
      code: "data_refreshed",
      label: "Данные обновлены",
      explanation: "Существенных изменений с прошлой проверки не обнаружено.",
      detectedAt,
      confidence: "high",
    });
  }
  const meaningful = changes.filter(({ code }) => code !== "data_refreshed");
  const priorityInsights = [
    ...(meaningful.length > 0
      ? [
          {
            code: "timing" as const,
            label: "Появился новый сигнал",
            explanation: meaningful.map(({ label }) => label).join(" · "),
            confidence: meaningful.some(({ confidence }) => confidence === "high")
              ? ("high" as const)
              : ("medium" as const),
          },
        ]
      : []),
    ...(current.brief.priorityInsights ?? []).filter(({ code }) => code !== "timing"),
  ];
  return {
    ...current,
    changeSignals: changes,
    brief: {
      ...current.brief,
      priorityInsights,
      whyNow:
        meaningful.length > 0
          ? `${meaningful.map(({ explanation }) => explanation).join(" ")} ${current.brief.whyNow ?? ""}`.trim()
          : current.brief.whyNow,
    },
  };
}

export function mergeRadarFeatures(
  current: RadarCandidateFeatures,
  extracted: Partial<RadarCandidateFeatures>,
): RadarCandidateFeatures {
  return {
    topic: current.topic ?? extracted.topic ?? null,
    language: current.language ?? extracted.language ?? null,
    geography: current.geography ?? extracted.geography ?? null,
    publicationFrequency:
      current.publicationFrequency === "unknown"
        ? (extracted.publicationFrequency ?? "unknown")
        : current.publicationFrequency,
    contactsFound: current.contactsFound || extracted.contactsFound === true,
    cms: current.cms ?? extracted.cms ?? null,
    estimatedVideoPagesMin:
      current.estimatedVideoPagesMin ?? extracted.estimatedVideoPagesMin ?? null,
    estimatedVideoPagesMax:
      current.estimatedVideoPagesMax ?? extracted.estimatedVideoPagesMax ?? null,
    // Оценка трафика: сохраняем прежнюю, если была; иначе принимаем свежую
    // из инспекции (Tranco/Similarweb). Не переносить в candidate.features
    // значение инспекции нельзя — Радар терял фактор «Оценка охвата» целиком.
    trafficEstimate: current.trafficEstimate ?? extracted.trafficEstimate ?? null,
  };
}

function signal(
  label: string,
  value: string,
  source: string,
  confidence: RadarConfidence,
): SignalInput {
  return { label, value, source, confidence };
}

function detectTopic(html: string, summary: string) {
  const explicit =
    metaContent(html, "article:section") ??
    metaContent(html, "section") ??
    metaContent(html, "category");
  if (explicit && explicit.length <= 80) {
    return {
      value: compactText(explicit),
      source: "метаданные раздела",
      confidence: "high" as const,
    };
  }
  const normalized = summary.toLocaleLowerCase("ru-RU");
  const topics: Array<{ value: string; words: string[] }> = [
    {
      value: "Спорт",
      words: ["спорт", "футбол", "хоккей", "теннис", "матч", "чемпионат", "спортсмен"],
    },
    {
      value: "Технологии",
      words: ["технолог", "гаджет", "software", "разработ", "искусственн", "интернет"],
    },
    { value: "Финансы и бизнес", words: ["финанс", "бизнес", "банк", "рынок", "инвест", "эконом"] },
    { value: "Новости", words: ["новост", "событи", "происшеств", "общество", "политик"] },
    { value: "Развлечения", words: ["кино", "сериал", "музык", "шоу", "знаменит"] },
    { value: "Здоровье", words: ["здоров", "медицин", "врач", "клиник", "лечение"] },
    { value: "Образование", words: ["образован", "обучен", "курс", "университет", "школ"] },
    { value: "Автомобили", words: ["автомоб", "машин", "авто ", "тест-драйв"] },
    { value: "Путешествия", words: ["путешеств", "туризм", "отел", "авиабилет", "курорт"] },
    { value: "Стиль жизни", words: ["lifestyle", "стиль жизни", "мода", "ресторан", "рецепт"] },
  ];
  const ranked = topics
    .map((topic) => ({
      ...topic,
      score: topic.words.reduce((score, word) => score + occurrences(normalized, word), 0),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  return best && best.score > 0
    ? {
        value: best.value,
        source: "title и meta description",
        confidence: best.score >= 2 ? ("medium" as const) : ("low" as const),
      }
    : null;
}

const GEO_PATTERNS: Array<[RegExp, string]> = [
  // Внимание: \b в JS опирается на ASCII-\w и НЕ работает на кириллице —
  // поэтому паттерны подстрочные, без \b (иначе города РФ не находятся вовсе).
  [/российск|росси[аиуюй]|\brussia\b/i, "Россия"],
  [/снг|\bcis\b/i, "СНГ"],
  [/казахстан/i, "Казахстан"],
  [/беларус/i, "Беларусь"],
  [/украин/i, "Украина"],
  // Крупные города РФ в тексте/мета — уверенный признак российской географии.
  [
    /москв|петербург|спб|новосибирск|екатеринбург|казан[ьи]|нижн\w*\s*новгород|краснодар|самар[ае]|ростов-на-дону|уф[ае]|владивосток|сочи/i,
    "Россия",
  ],
];

/** Адрес организации в JSON-LD: addressCountry/addressLocality с РФ-маркерами. */
const JSON_LD_RU_ADDRESS =
  /"addressCountry"\s*:\s*(?:"\s*(?:ru|rus|russia|рф|росси[ия])[^"]*"|\{[^{}]*"name"\s*:\s*"[^"]*(?:росси|рф|russia)[^"]*")/i;

function detectGeography(html: string, summary: string) {
  const explicit = metaContent(html, "geo.placename") ?? metaContent(html, "geo.region");
  if (explicit)
    return {
      value: compactText(explicit),
      source: "географические метаданные",
      confidence: "high" as const,
    };
  // JSON-LD адрес организации — самый надёжный сигнал после geo-меты.
  if (JSON_LD_RU_ADDRESS.test(html))
    return {
      value: "Россия",
      source: "JSON-LD адрес",
      confidence: "high" as const,
    };
  const normalized = summary.toLocaleLowerCase("ru-RU");
  const summaryMatch = GEO_PATTERNS.find(([pattern]) => pattern.test(normalized));
  if (summaryMatch)
    return {
      value: summaryMatch[1],
      source: "title и meta description",
      confidence: "medium" as const,
    };
  // Текст страницы (футер, реквизиты, «О нас»): слабее title/meta, но часто
  // единственный источник для сайтов без гео-метаданных.
  const visible = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .toLocaleLowerCase("ru-RU")
    .slice(0, 200_000);
  const bodyMatch = GEO_PATTERNS.find(([pattern]) => pattern.test(visible));
  if (bodyMatch)
    return {
      value: bodyMatch[1],
      source: "текст страницы",
      confidence: "low" as const,
    };
  return null;
}

function detectPublicationFrequency(html: string): {
  value: RadarCandidateFeatures["publicationFrequency"];
  count: number;
  confidence: RadarConfidence;
} | null {
  const values = [
    ...matches(html, /\bdatetime\s*=\s*["']([^"']+)["']/gi),
    ...matches(html, /["']datePublished["']\s*:\s*["']([^"']+)["']/gi),
  ];
  const dates = [...new Set(values)]
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((left, right) => right.time - left.time);
  if (dates.length < 2) return null;
  const uniqueDays = new Set(dates.map(({ value }) => value.slice(0, 10))).size;
  const spanDays = Math.max(
    1,
    Math.ceil(((dates[0]?.time ?? 0) - (dates.at(-1)?.time ?? 0)) / 86_400_000),
  );
  const perDay = dates.length / (spanDays + 1);
  if (dates.length >= 3 && (uniqueDays <= 2 || perDay >= 0.7)) {
    return { value: "daily", count: dates.length, confidence: "high" };
  }
  if (perDay >= 0.12 || spanDays <= 14)
    return { value: "weekly", count: dates.length, confidence: "medium" };
  return { value: "monthly", count: dates.length, confidence: "low" };
}

/**
 * Частота публикаций по датам из RSS/Atom-ленты. Лента отражает свежий
 * поток материалов: плотность дат за период даёт честную полосу
 * daily/weekly/monthly без запроса дополнительных страниц.
 */
export function publicationFrequencyFromFeedDates(dateStrings: string[]): {
  value: RadarCandidateFeatures["publicationFrequency"];
  count: number;
  confidence: RadarConfidence;
} | null {
  const dates = [...new Set(dateStrings)]
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((left, right) => right.time - left.time);
  if (dates.length < 2) return null;
  const uniqueDays = new Set(dates.map(({ value }) => value.slice(0, 10))).size;
  const spanDays = Math.max(
    1,
    Math.ceil(((dates[0]?.time ?? 0) - (dates.at(-1)?.time ?? 0)) / 86_400_000),
  );
  const perDay = dates.length / (spanDays + 1);
  if (dates.length >= 5 && (uniqueDays <= 3 || perDay >= 0.7)) {
    return { value: "daily", count: dates.length, confidence: "high" };
  }
  if (perDay >= 0.12 || spanDays <= 14)
    return { value: "weekly", count: dates.length, confidence: "medium" };
  return { value: "monthly", count: dates.length, confidence: "low" };
}

/**
 * Заполняет частоту публикаций из дат ленты, только если по странице она
 * не определилась («unknown»). Возвращает НОВЫЙ объект экстракции —
 * результат присваивать (ловушка №8).
 */
export function applyFeedPublicationFrequency(
  extraction: RadarPageFeatureExtraction,
  feedDateStrings: string[],
): RadarPageFeatureExtraction {
  const known =
    extraction.features.publicationFrequency &&
    extraction.features.publicationFrequency !== "unknown";
  const frequency = known ? null : publicationFrequencyFromFeedDates(feedDateStrings);
  if (!frequency) return extraction;
  return {
    ...extraction,
    features: { ...extraction.features, publicationFrequency: frequency.value },
    research: {
      ...extraction.research,
      signals: [
        ...extraction.research.signals.filter(
          ({ field }) => field !== "publicationFrequency",
        ),
        {
          field: "publicationFrequency" as const,
          label: "Частота публикаций",
          value: frequencyLabel(frequency.value),
          source: `${frequency.count} дат в RSS/Atom-ленте сайта`,
          confidence: frequency.confidence,
        },
      ],
    },
  };
}

function detectContacts(html: string, pageUrl: URL): RadarContactLead[] {
  const leads = new Map<string, RadarContactLead>();
  for (const link of anchorLinks(html, pageUrl)) {
    const raw = link.rawHref.trim();
    if (/^mailto:/i.test(raw)) {
      const email = safeDecode(raw.slice(7).split("?", 1)[0] ?? "")
        .trim()
        .toLocaleLowerCase("en-US");
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        leads.set(`email:${email}`, {
          type: "email",
          value: email,
          href: `mailto:${email}`,
          sourceUrl: pageUrl.toString(),
          confidence: "high",
        });
      }
      continue;
    }
    if (/^tel:/i.test(raw)) {
      const decoded = safeDecode(raw.slice(4).split("?", 1)[0] ?? "").trim();
      const phone = `${decoded.startsWith("+") ? "+" : ""}${decoded.replace(/\D/g, "")}`;
      if (phone.replace(/\D/g, "").length >= 7) {
        leads.set(`phone:${phone}`, {
          type: "phone",
          value: phone,
          href: `tel:${phone}`,
          sourceUrl: pageUrl.toString(),
          confidence: "high",
        });
      }
      continue;
    }
    // Telegram-канал/аккаунт площадки: t.me/username, telegram.me/*.
    if (link.url && /^(?:www\.)?(?:t|telegram)\.me$/i.test(link.url.hostname)) {
      const handle = decodeURIComponent(link.url.pathname.replace(/^\//, "")).replace(/\/+$/, "");
      const clean = (handle.split("?")[0] ?? "").trim();
      if (/^[A-Za-z0-9_]{3,64}$/.test(clean) && !/^(share|joinchat|s)$/i.test(clean)) {
        leads.set(`telegram:${clean.toLowerCase()}`, {
          type: "telegram",
          value: `@${clean}`,
          href: `https://t.me/${clean}`,
          sourceUrl: pageUrl.toString(),
          confidence: "high",
          kind: classifyTelegramLead(html, link.index, clean),
        });
      }
      continue;
    }
    if (
      link.url &&
      link.url.hostname === pageUrl.hostname &&
      /(?:^|\/)(?:contacts?|kontakty|about|feedback)(?:\/|$)/i.test(link.url.pathname)
    ) {
      leads.set(`contact_page:${link.url.toString()}`, {
        type: "contact_page",
        value: link.label || "Страница контактов",
        href: link.url.toString(),
        sourceUrl: pageUrl.toString(),
        confidence: "medium",
      });
    }
  }
  return [...leads.values()].slice(0, 12);
}

/**
 * Чей Telegram-канал: «площадки» (site) или «автора» (author)?
 * Эвристики по позиции в DOM:
 *  - ссылка внутри <footer>…</footer> → канал площадки (соцсети в подвале);
 *  - ссылка внутри открытого блока <article> → канал автора материала;
 *  - хэндл повторяется на странице ≥ 2 раз → канал площадки;
 *  - иначе классификация неизвестна (kind не ставится).
 */
export function classifyTelegramLead(
  html: string,
  linkIndex: number,
  handle: string,
): "site" | "author" | undefined {
  const lower = html.toLocaleLowerCase("en-US");
  const footerStart = lower.lastIndexOf("<footer");
  if (footerStart >= 0 && footerStart < linkIndex) {
    const footerEnd = lower.indexOf("</footer>", footerStart);
    if (footerEnd === -1 || footerEnd > linkIndex) return "site";
  }
  const before = lower.slice(0, Math.max(0, linkIndex));
  const openArticles = (before.match(/<article\b/g) ?? []).length;
  const closeArticles = (before.match(/<\/article>/g) ?? []).length;
  if (openArticles > closeArticles) return "author";
  const repeats = occurrences(lower, `t.me/${handle.toLowerCase()}`);
  if (repeats >= 2) return "site";
  return undefined;
}

/** Hard cap on candidate HTML blocks scanned per page to bound regex work. */
const MAX_DECISION_MAKER_BLOCKS = 200;

function detectDecisionMakers(html: string, pageUrl: URL): RadarDecisionMakerLead[] {
  const leads: RadarDecisionMakerLead[] = [];
  for (const rawJson of matches(
    html,
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue;
    }
    for (const person of structuredPeople(parsed)) {
      const role = textValue(person.jobTitle);
      const fullName = textValue(person.name);
      if (!role || !fullName || !decisionRole(role)) continue;
      const email = normalizeEmail(textValue(person.email));
      const phone = normalizePhone(textValue(person.telephone));
      const profileUrl = resolveProfileUrl(textValue(person.url), pageUrl);
      leads.push({
        fullName,
        role: compactText(role),
        department: departmentForRole(role),
        email,
        phone,
        profileUrl,
        sourceUrl: pageUrl.toString(),
        evidence: `Schema.org Person: ${fullName}, ${compactText(role)}`,
        confidence: email || phone ? "high" : "medium",
      });
    }
  }

  const blocks = [
    ...matches(
      html,
      /<(?:article|section|li)\b[^>]*>([\s\S]{0,4000}?)<\/(?:article|section|li)>/gi,
    ).slice(0, MAX_DECISION_MAKER_BLOCKS),
    ...matches(
      html,
      /<div\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:team|staff|person|employee|author|contact|management|editor|rukovodstvo|komanda|directors|leadership|founders|about)[^"']*["'][^>]*>([\s\S]{0,4000}?)<\/div>/gi,
    ).slice(0, MAX_DECISION_MAKER_BLOCKS),
  ].slice(0, MAX_DECISION_MAKER_BLOCKS);
  for (const block of blocks) {
    const role = decisionRole(compactText(block));
    if (!role) continue;
    const fullName = findPersonName(block, role);
    if (!fullName) continue;
    const contacts = detectContacts(block, pageUrl);
    const email = contacts.find(({ type }) => type === "email")?.value ?? null;
    const phone = contacts.find(({ type }) => type === "phone")?.value ?? null;
    const profileUrl = findProfileUrl(block, pageUrl);
    leads.push({
      fullName,
      role,
      department: departmentForRole(role),
      email,
      phone,
      profileUrl,
      sourceUrl: pageUrl.toString(),
      evidence: compactText(block).slice(0, 280),
      confidence: email || phone ? "high" : "medium",
    });
  }
  for (const block of matches(html, /<(?:p|li)\b[^>]*>([\s\S]{0,1800}?)<\/(?:p|li)>/gi).slice(
    0,
    MAX_DECISION_MAKER_BLOCKS,
  )) {
    for (const link of anchorLinks(block, pageUrl)) {
      if (!/^(?:mailto|tel):/i.test(link.rawHref)) continue;
      const linkPosition = link.index;
      const context = compactText(
        block.slice(Math.max(0, linkPosition - 320), linkPosition + link.rawHref.length + 60),
      );
      const functional = functionalContactRole(context);
      if (!functional) continue;
      const email = /^mailto:/i.test(link.rawHref) ? normalizeEmail(link.rawHref) : null;
      const phone = /^tel:/i.test(link.rawHref) ? normalizePhone(link.rawHref) : null;
      if (!email && !phone) continue;
      leads.push({
        fullName: null,
        role: functional.role,
        department: functional.department,
        email,
        phone,
        profileUrl: null,
        sourceUrl: pageUrl.toString(),
        evidence: compactText(block).slice(0, 280),
        confidence: "medium",
      });
    }
  }
  return mergeDecisionMakers(leads).slice(0, 10);
}

function detectCms(html: string) {
  const generator = metaContent(html, "generator");
  if (generator) {
    const known = [
      "WordPress",
      "Drupal",
      "Joomla",
      "Ghost",
      "Tilda",
      "Wix",
      "Webflow",
      "1C-Битрикс",
    ].find((name) =>
      generator.toLocaleLowerCase("ru-RU").includes(name.toLocaleLowerCase("ru-RU")),
    );
    return {
      value: known ?? compactText(generator).slice(0, 120),
      source: "meta generator",
      confidence: "high" as const,
    };
  }
  const fingerprints: Array<[RegExp, string, RadarConfidence]> = [
    [/wp-(?:content|includes)\//i, "WordPress", "high"],
    [/(?:bitrix|bx\.setcsslist)/i, "1C-Битрикс", "high"],
    [/(?:drupal-settings-json|sites\/default\/files)/i, "Drupal", "high"],
    [/(?:__next_data__|\/_next\/static)/i, "Next.js", "high"],
    [/(?:__nuxt__|\/_nuxt\/)/i, "Nuxt", "high"],
    [/\bng-version\s*=/i, "Angular", "high"],
    [/\bdata-rh\s*=/i, "React / SSR", "low"],
  ];
  const match = fingerprints.find(([pattern]) => pattern.test(html));
  return match ? { value: match[1], source: "HTML fingerprint", confidence: match[2] } : null;
}

/** Похоже ли URL на страницу с видео (для ссылок на странице и для sitemap). */
export function looksLikeVideoUrl(url: URL): boolean {
  return (
    /(?:^|\/)videos?(?:\/|$)|(?:^|\/)(?:watch|embed|translyac(?:iya|ii|iy)|live|efir)(?:\/|$)/i.test(
      url.pathname,
    ) || /\.mp4$/i.test(url.pathname)
  );
}

function detectVideoPageLinks(html: string, pageUrl: URL): RadarVideoPageLead[] {
  const leads = new Map<string, RadarVideoPageLead>();
  for (const link of anchorLinks(html, pageUrl)) {
    if (!link.url || link.url.hostname !== pageUrl.hostname) continue;
    if (looksLikeVideoUrl(link.url)) {
      link.url.hash = "";
      leads.set(link.url.toString(), {
        pageUrl: link.url.toString(),
        label: link.label || link.url.pathname,
        sourceUrl: pageUrl.toString(),
        confidence: "low",
      });
    }
  }
  if (
    /<video\b|["']@type["']\s*:\s*["']VideoObject["']|<(?:iframe|embed)\b[^>]*(?:rutube|youtube|vkvideo)/i.test(
      html,
    )
  ) {
    leads.set(pageUrl.toString(), {
      pageUrl: pageUrl.toString(),
      label: firstTagText(html, "title") ?? "Переданная страница",
      sourceUrl: pageUrl.toString(),
      confidence: "medium",
    });
  }
  return [...leads.values()].slice(0, 12);
}

function buildWorkBrief(
  features: Partial<RadarCandidateFeatures>,
  contacts: RadarContactLead[],
  decisionMakers: RadarDecisionMakerLead[],
  videoPages: RadarVideoPageLead[],
  pageUrl: URL,
  coverage?: RadarResearchCoverage,
): RadarWorkBrief {
  const namedContact =
    decisionMakers.find(({ email, phone }) => email || phone) ?? decisionMakers[0];
  const directContact =
    contacts.find(({ type }) => type === "email") ?? contacts.find(({ type }) => type === "phone");
  const contactPage = contacts.find(({ type }) => type === "contact_page");
  const topic = features.topic ?? "контентная площадка";
  const geography = features.geography ? `, география — ${features.geography}` : "";
  const frequency =
    features.publicationFrequency && features.publicationFrequency !== "unknown"
      ? `, публикации — ${frequencyLabel(features.publicationFrequency)}`
      : "";
  const traffic = features.trafficEstimate;
  const trafficSummary =
    traffic?.minDailyVisits !== undefined && traffic.maxDailyVisits !== undefined
      ? ` Оценка посещаемости: ${formatNumber(traffic.minDailyVisits)}–${formatNumber(traffic.maxDailyVisits)} в день.`
      : "";
  const siteSummary = `${topic}${geography}${frequency}. Проверен домен ${pageUrl.hostname}.${trafficSummary}`;
  const videoUsage =
    videoPages.length > 0
      ? `Найдены видеостраницы: ${videoPages
          .slice(0, 3)
          .map(({ label }) => label)
          .join(", ")}.`
      : "На переданной странице не найдено подтверждённых видеостраниц; сценарий нужно уточнить у площадки.";
  const rutubeUseCase = useCaseFor(features.topic);
  const likelyContactRoles = contactRolesFor(features.topic);
  const risks = [
    ...(videoPages.length === 0 ? ["Нет подтверждённого примера страницы с видео."] : []),
    ...(!namedContact && !directContact
      ? [
          contactPage
            ? "Найден только общий раздел контактов."
            : "Не найден прямой публичный канал связи.",
        ]
      : []),
    ...(!decisionMakers.some(({ fullName }) => fullName)
      ? ["Имя ЛПР не подтверждено; найдены только функциональные рабочие контакты."]
      : []),
    ...(!traffic ? ["Трафик не подтверждён внешним провайдером."] : []),
  ];
  const readiness: RadarWorkBrief["readiness"] =
    namedContact || directContact
      ? "ready_for_outreach"
      : contactPage
        ? "contact_page_found"
        : "needs_contact";
  const nextAction = namedContact
    ? namedContact.fullName
      ? `Связаться с ${namedContact.fullName} (${namedContact.role})${namedContact.email ? ` через ${namedContact.email}` : namedContact.phone ? ` по ${namedContact.phone}` : " через публичный профиль"}: проверить интерес к кейсу «${rutubeUseCase}».`
      : `Связаться через «${namedContact.role}»${namedContact.email ? ` — ${namedContact.email}` : namedContact.phone ? ` — ${namedContact.phone}` : " в публичном профиле"}: проверить интерес к кейсу «${rutubeUseCase}».`
    : directContact
      ? `Связаться через ${directContact.value}: проверить интерес к кейсу «${rutubeUseCase}» и запросить пример видеостраницы.`
      : contactPage
        ? `Открыть ${contactPage.href}, найти роль «${likelyContactRoles[0]}» и запросить пример видеостраницы.`
        : `Найти публичный контакт роли «${likelyContactRoles[0]}» и запросить пример видеостраницы.`;
  const priorityInsights = buildPriorityInsights(features, contacts, decisionMakers, videoPages);
  const whyNow =
    priorityInsights.length > 0
      ? priorityInsights
          .slice(0, 3)
          .map(({ explanation }) => explanation)
          .join(" ")
      : "Публичных сигналов срочности пока недостаточно — сначала нужно дополнить исследование.";
  const opportunityPotential = buildOpportunityPotential(features, videoPages, coverage);
  const outreach = buildOutreachPackage(
    namedContact,
    directContact,
    contactPage,
    topic,
    rutubeUseCase,
    likelyContactRoles[0] ?? "Руководитель видеонаправления",
  );
  return {
    readiness,
    siteSummary,
    videoUsage,
    rutubeUseCase,
    likelyContactRoles,
    risks,
    nextAction,
    whyNow,
    priorityInsights,
    opportunityPotential,
    outreach,
  };
}

function buildPriorityInsights(
  features: Partial<RadarCandidateFeatures>,
  contacts: RadarContactLead[],
  decisionMakers: RadarDecisionMakerLead[],
  videoPages: RadarVideoPageLead[],
): RadarPriorityInsight[] {
  const insights: RadarPriorityInsight[] = [];
  const traffic = features.trafficEstimate;
  if (traffic?.minDailyVisits !== undefined && traffic.maxDailyVisits !== undefined) {
    insights.push({
      code: "reach",
      label: "Подтверждён охват",
      explanation: `Внешняя оценка — ${formatNumber(traffic.minDailyVisits)}–${formatNumber(traffic.maxDailyVisits)} посещений в день.`,
      confidence: traffic.confidence,
    });
  }
  if (features.publicationFrequency === "daily") {
    insights.push({
      code: "publishing",
      label: "Ежедневный контент",
      explanation:
        "Площадка публикует материалы ежедневно — видеосценарий может получать регулярный инвентарь.",
      confidence: "high",
    });
  } else if (features.publicationFrequency === "weekly") {
    insights.push({
      code: "publishing",
      label: "Регулярный контент",
      explanation:
        "Площадка публикует материалы еженедельно и подходит для повторяемого видеосценария.",
      confidence: "medium",
    });
  }
  if (videoPages.length > 0) {
    insights.push({
      code: "video",
      label: "Видео уже используется",
      explanation: `Подтверждены видеостраницы (${videoPages.length}) — интеграционный сценарий можно показать на реальных материалах.`,
      confidence: videoPages.some(
        ({ confidence }) => confidence === "medium" || confidence === "high",
      )
        ? "medium"
        : "low",
    });
  }
  const directLpr = decisionMakers.find(
    ({ email, phone, profileUrl }) => email || phone || profileUrl,
  );
  const directContact = contacts.find(({ type }) => type === "email" || type === "phone");
  if (directLpr || directContact) {
    insights.push({
      code: "contact",
      label: directLpr ? "ЛПР доступен" : "Есть прямой канал",
      explanation: directLpr
        ? `Найден целевой контакт ${directLpr.fullName ?? directLpr.role} и публичный канал для первого касания.`
        : `Найден прямой публичный канал ${directContact?.value}.`,
      confidence: directLpr?.confidence ?? directContact?.confidence ?? "medium",
    });
  }
  return insights;
}

function buildOpportunityPotential(
  features: Partial<RadarCandidateFeatures>,
  videoPages: RadarVideoPageLead[],
  coverage?: RadarResearchCoverage,
): RadarOpportunityPotential {
  const traffic = features.trafficEstimate;
  const inspected = coverage?.inspectedUrls ?? 1;
  const videoObserved = coverage?.videoPagesObserved ?? videoPages.length;
  const observedVideoSharePercent =
    inspected > 0 ? Math.min(100, Math.round((videoObserved / inspected) * 100)) : null;
  const share = observedVideoSharePercent === null ? null : observedVideoSharePercent / 100;
  const minDailyVisits = traffic?.minDailyVisits ?? null;
  const maxDailyVisits = traffic?.maxDailyVisits ?? null;
  const minMonthlyVideoOpportunities =
    minDailyVisits !== null && share !== null ? Math.round(minDailyVisits * share * 30) : null;
  const maxMonthlyVideoOpportunities =
    maxDailyVisits !== null && share !== null ? Math.round(maxDailyVisits * share * 30) : null;
  return {
    minDailyVisits,
    maxDailyVisits,
    observedVideoSharePercent,
    minMonthlyVideoOpportunities,
    maxMonthlyVideoOpportunities,
    basis: traffic
      ? `Оценка трафика ${traffic.provider} и доля видеостраниц в проверенной выборке ${videoObserved}/${inspected}.`
      : `Доля видеостраниц в проверенной выборке ${videoObserved}/${inspected}; внешний трафик не подключён.`,
    confidence: traffic && inspected >= 5 ? "high" : traffic || inspected >= 3 ? "medium" : "low",
  };
}

function buildOutreachPackage(
  namedContact: RadarDecisionMakerLead | undefined,
  directContact: RadarContactLead | undefined,
  contactPage: RadarContactLead | undefined,
  topic: string,
  rutubeUseCase: string,
  fallbackRole: string,
): RadarOutreachPackage {
  const channel: RadarOutreachPackage["channel"] =
    namedContact?.email || directContact?.type === "email"
      ? "email"
      : namedContact?.phone || directContact?.type === "phone"
        ? "phone"
        : namedContact?.profileUrl
          ? "profile"
          : contactPage
            ? "contact_page"
            : "research";
  const destination =
    namedContact?.email ??
    namedContact?.phone ??
    namedContact?.profileUrl ??
    directContact?.value ??
    contactPage?.href ??
    null;
  const targetRole = namedContact?.role ?? fallbackRole;
  const greeting = namedContact?.fullName
    ? `Здравствуйте, ${namedContact.fullName}!`
    : "Здравствуйте!";
  return {
    targetName: namedContact?.fullName ?? null,
    targetRole,
    channel,
    destination,
    subject: `Видео для ${topic.toLocaleLowerCase("ru-RU")}: сценарий RUTUBE`,
    messageDraft: `${greeting} Команда RUTUBE изучила публичные материалы площадки и видит подходящий сценарий: ${rutubeUseCase}. Предлагаем коротко обсудить, как встроить RUTUBE-плеер в текущий редакционный процесс и измерить результат на пилоте. Подскажите, пожалуйста, кто отвечает за видеонаправление и интеграцию?`,
    discoveryQuestions: [
      "Сколько новых материалов с видео выходит в обычную неделю?",
      "Какой плеер используется сейчас и какие ограничения мешают его развитию?",
      "Кто отвечает за редакционный сценарий, техническую интеграцию и метрики?",
    ],
    nextTask:
      channel === "research"
        ? `Найти публичный контакт роли «${targetRole}» и подтвердить видеосценарий.`
        : `Проверить адресата и подготовить персональное первое касание для роли «${targetRole}».`,
  };
}

function decisionMakerKey(person: RadarDecisionMakerLead) {
  return (
    person.email ??
    person.phone ??
    `${person.fullName ?? ""}:${person.role}`.toLocaleLowerCase("ru-RU")
  );
}

function researchLinkScore(value: string) {
  if (/contacts?|kontakty|контакт|feedback|обратн.*связ/.test(value)) return 100;
  // Реквизиты/оферта — главный источник ИНН/ОГРН для обогащения через ЕГРЮЛ.
  if (/rekvizit|реквизит|inn|огрн|ogrn|oferta|офер|agreement|договор|terms|условия|правил|privacy|политик|document|docs/.test(value))
    return 95;
  if (/team|staff|people|management|leadership|команд|руковод/.test(value)) return 90;
  if (/editorial|редакц|authors?|автор/.test(value)) return 80;
  if (/advertis|reklam|реклам|partners?|партн[её]р/.test(value)) return 70;
  if (/about|company|о\s+компан|о\s+нас/.test(value)) return 60;
  return 0;
}

const roleDefinitions: Array<{ pattern: RegExp; department: string }> = [
  {
    // Специфичные «замы» — раньше общего «генерального директора»,
    // иначе match съест слово «заместитель».
    pattern:
      /(?:заместител[ья]\s+(?:генеральн(?:ого|ый|ая)\s+)?директора|зам\.\s*директора|deputy (?:general )?director)/i,
    department: "Руководство",
  },
  {
    pattern: /(?:исполнительн(?:ый|ая)\s+директор|executive director)/i,
    department: "Руководство",
  },
  {
    pattern: /(?:генеральн(?:ый|ая)\s+директор|chief executive officer|\bceo\b)/i,
    department: "Руководство",
  },
  {
    pattern:
      /(?:директор\s+по\s+развитию|руководитель\s+по\s+развитию|business development director|head of business development|head of partnerships?)/i,
    department: "Развитие бизнеса",
  },
  {
    pattern: /(?:коммерческ(?:ий|ая)\s+директор|chief commercial officer|\bcco\b)/i,
    department: "Коммерческий отдел",
  },
  {
    pattern:
      /(?:(?:руководитель|директор)\s+(?:отдела\s+)?продаж|head of sales|sales director)/i,
    department: "Коммерческий отдел",
  },
  { pattern: /(?:главн(?:ый|ая)\s+редактор|editor[- ]in[- ]chief)/i, department: "Редакция" },
  {
    pattern:
      /(?:руководитель\s+видео(?:редакции|направления)?|директор\s+по\s+видео|head of video)/i,
    department: "Видеоредакция",
  },
  { pattern: /(?:директор\s+по\s+продукту|chief product officer|\bcpo\b)/i, department: "Продукт" },
  {
    pattern:
      /(?:(?:директор\s+по\s+маркетингу|маркетингов(?:ый|ая)\s+директор|chief marketing officer|\bcmo\b)|pr[- ]директор|директор\s+по\s+pr)/i,
    department: "Маркетинг и PR",
  },
  {
    pattern: /(?:техническ(?:ий|ая)\s+директор|chief technology officer|\bcto\b)/i,
    department: "Технологии",
  },
];

function decisionRole(value: string) {
  for (const definition of roleDefinitions) {
    const match = value.match(definition.pattern)?.[0];
    if (match) return match.trim().replace(/^./, (letter) => letter.toLocaleUpperCase("ru-RU"));
  }
  return null;
}

function departmentForRole(role: string) {
  return roleDefinitions.find(({ pattern }) => pattern.test(role))?.department ?? null;
}

function functionalContactRole(value: string) {
  const definitions: Array<{ pattern: RegExp; role: string; department: string }> = [
    {
      pattern:
        /(?:по\s+вопросам\s+сотрудничества|предложени[яе]\s+о\s+сотрудничестве|business inquiries|partnership inquiries)/i,
      role: "Ответственный за сотрудничество",
      department: "Развитие бизнеса",
    },
    {
      pattern: /(?:по\s+вопросам\s+рекламы|размещени[яе]\s+рекламы|advertising inquiries)/i,
      role: "Ответственный за рекламу",
      department: "Коммерческий отдел",
    },
    {
      pattern: /(?:связ[ьи]\s+с\s+редакцией|для\s+редакции|email\s+редакции|editorial inquiries)/i,
      role: "Контакт редакции",
      department: "Редакция",
    },
    {
      pattern:
        /(?:нашли\s+баг|ошибк[ау]\s+на\s+сайте|техническ(?:ий|ие)\s+вопрос|предложени[яе]\s+по\s+улучшению)/i,
      role: "Технический контакт",
      department: "Технологии",
    },
  ];
  const match = definitions
    .map((definition) => ({ definition, index: value.match(definition.pattern)?.index ?? -1 }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => right.index - left.index)[0]?.definition;
  return match ? { role: match.role, department: match.department } : null;
}

function findPersonName(block: string, role: string) {
  const tagged = [
    ...block.matchAll(/<(?:h[1-6]|strong|b|a)\b[^>]*>([\s\S]*?)<\/(?:h[1-6]|strong|b|a)>/gi),
  ].map((match) => compactText(match[1] ?? ""));
  const plain = compactText(block).replace(role, " ");
  for (const value of [...tagged, plain]) {
    const match = value.match(
      /(?:[А-ЯЁ][а-яё-]{1,30}|[A-Z][a-z-]{1,30})(?:\s+(?:[А-ЯЁ][а-яё-]{1,30}|[A-Z][a-z-]{1,30})){1,2}/,
    )?.[0];
    if (match && !decisionRole(match) && !/^(?:Email|Phone|Позвонить|Контакты)/i.test(match))
      return match;
  }
  return null;
}

function normalizeEmail(value: string | null) {
  if (!value) return null;
  const email = value
    .replace(/^mailto:/i, "")
    .trim()
    .toLocaleLowerCase("en-US");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizePhone(value: string | null) {
  if (!value) return null;
  const decoded = value.replace(/^tel:/i, "").trim();
  const phone = `${decoded.startsWith("+") ? "+" : ""}${decoded.replace(/\D/g, "")}`;
  return phone.replace(/\D/g, "").length >= 7 ? phone : null;
}

function findProfileUrl(block: string, pageUrl: URL) {
  const link = anchorLinks(block, pageUrl).find(
    ({ url }) => url && /team|staff|person|people|author|editor|management/i.test(url.pathname),
  );
  return link?.url ? link.url.toString() : null;
}

function resolveProfileUrl(value: string | null, pageUrl: URL) {
  if (!value) return null;
  try {
    const url = new URL(value, pageUrl);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function structuredPeople(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(structuredPeople);
  if (!isRecord(value)) return [];
  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];
  const current = types.some(
    (item) => typeof item === "string" && item.toLocaleLowerCase("en-US") === "person",
  )
    ? [value]
    : [];
  return [...current, ...Object.values(value).flatMap(structuredPeople)];
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function mergeDecisionMakers(leads: RadarDecisionMakerLead[]) {
  const merged = new Map<string, RadarDecisionMakerLead>();
  for (const lead of leads) {
    const key =
      lead.email ??
      `${lead.fullName?.toLocaleLowerCase("ru-RU")}:${lead.role.toLocaleLowerCase("ru-RU")}`;
    const current = merged.get(key);
    merged.set(
      key,
      current
        ? {
            ...current,
            email: current.email ?? lead.email,
            phone: current.phone ?? lead.phone,
            profileUrl: current.profileUrl ?? lead.profileUrl,
            confidence:
              current.confidence === "high" || lead.confidence === "high" ? "high" : "medium",
          }
        : lead,
    );
  }
  return [...merged.values()].sort(
    (left, right) =>
      rolePriority(left.role) - rolePriority(right.role) ||
      Number(Boolean(right.email || right.phone)) - Number(Boolean(left.email || left.phone)),
  );
}

function rolePriority(role: string) {
  const functionalPriorities: Record<string, number> = {
    "Ответственный за сотрудничество": 2.5,
    "Ответственный за рекламу": 3.5,
    "Контакт редакции": 4.5,
    "Технический контакт": 7,
  };
  if (functionalPriorities[role] !== undefined) return functionalPriorities[role];
  const index = roleDefinitions.findIndex(({ pattern }) => pattern.test(role));
  return index < 0 ? roleDefinitions.length : index;
}

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

function useCaseFor(topic: string | null | undefined) {
  const normalized = topic?.toLocaleLowerCase("ru-RU") ?? "";
  if (normalized.includes("спорт"))
    return "спортивные хайлайты, интервью и разборы матчей в RUTUBE-плеере";
  if (normalized.includes("новост")) return "видеоновости и репортажи в RUTUBE-плеере";
  if (normalized.includes("технолог")) return "обзоры, интервью и обучающие видео в RUTUBE-плеере";
  if (normalized.includes("развлеч") || normalized.includes("кино"))
    return "трейлеры, интервью и развлекательные видео в RUTUBE-плеере";
  return "редакционные видео и интервью в RUTUBE-плеере";
}

function contactRolesFor(topic: string | null | undefined) {
  const normalized = topic?.toLocaleLowerCase("ru-RU") ?? "";
  return normalized.includes("спорт")
    ? ["Видеоредакция", "Главный редактор", "Коммерческий отдел", "Технический специалист"]
    : ["Видеоредакция", "Редакционный директор", "Коммерческий отдел", "Технический специалист"];
}

function anchorLinks(html: string, pageUrl: URL) {
  const links: Array<{ rawHref: string; url: URL | null; label: string; index: number }> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const rawHref = attribute(match[1] ?? "", "href");
    if (!rawHref) continue;
    let url: URL | null = null;
    if (!/^(?:mailto|tel):/i.test(rawHref)) {
      try {
        url = new URL(rawHref.replace(/&amp;/gi, "&"), pageUrl);
      } catch {
        // Ignore malformed links from untrusted HTML.
      }
    }
    links.push({ rawHref, url, label: compactText(match[2] ?? ""), index: match.index ?? 0 });
  }
  return links;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function metaContent(html: string, key: string) {
  const target = key.toLocaleLowerCase("en-US");
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attribute(tag, "name") ?? attribute(tag, "property") ?? attribute(tag, "itemprop");
    if (name?.toLocaleLowerCase("en-US") !== target) continue;
    const content = attribute(tag, "content");
    if (content) return compactText(content);
  }
  return null;
}

function htmlAttribute(html: string, name: string) {
  const tag = html.match(/<html\b[^>]*>/i)?.[0];
  return tag ? attribute(tag, name) : null;
}

function attribute(tag: string, name: string) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"),
  );
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "") || null;
}

function firstTagText(html: string, tag: string) {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? compactText(match[1]) : null;
}

function compactText(value: string) {
  return decodeHtml(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function matches(source: string, pattern: RegExp) {
  return [...source.matchAll(pattern)].flatMap((match) => (match[1] ? [decodeHtml(match[1])] : []));
}

function occurrences(source: string, needle: string) {
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function frequencyLabel(value: RadarCandidateFeatures["publicationFrequency"]) {
  return {
    daily: "Ежедневно",
    weekly: "Еженедельно",
    monthly: "Ежемесячно",
    unknown: "Не определено",
  }[value];
}
