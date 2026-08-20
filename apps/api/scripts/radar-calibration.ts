/**
 * Partner Score calibration report.
 *
 * Reads every radar decision that captured `score_at_decision` (fixed at the
 * moment the manager decided) straight from PostgreSQL and prints to stdout:
 *   (a) per score bucket (0-19/20-39/40-59/60-79/80-100): total decisions and
 *       the accept share — is a higher score actually accepted more often;
 *   (b) the reason_code distribution among rejects — what the model misses;
 *   (c) for accepted candidates: how many reached an actual Placement.
 *
 * Candidate → Organization link: primarily via `accepted_organization_id`
 * (the accept flow creates the Organization in the same transaction). For
 * older accepts without that column the fallback is a domain match
 * (radar_candidate.host_normalized = domain.host_normalized) — weaker, but
 * the only remaining link.
 *
 * Usage: npm run radar:calibration  (DATABASE_URL overrides the default).
 */
import { PrismaClient } from "@prisma/client";

const DEFAULT_DATABASE_URL =
  "postgresql://embed_os:embed_os@127.0.0.1:55432/embed_os?schema=public";
const MIN_DECISIONS_FOR_CONCLUSIONS = 30;

const SCORE_BUCKETS = [
  { label: "0-19", min: 0, max: 19 },
  { label: "20-39", min: 20, max: 39 },
  { label: "40-59", min: 40, max: 59 },
  { label: "60-79", min: 60, max: 79 },
  { label: "80-100", min: 80, max: 100 },
] as const;

const REJECT_REASON_LABELS: Record<string, string> = {
  no_video_editorial: "Нет видеоредакции",
  competitor_exclusive: "Эксклюзив у конкурента",
  dead_site: "Мёртвый сайт",
  low_traffic: "Низкий трафик",
  irrelevant_topic: "Нерелевантная тематика",
  other: "Другое",
};

async function main() {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
  });
  try {
    const decisions = await prisma.radarDecision.findMany({
      where: { scoreAtDecision: { not: null } },
      orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
      select: {
        decision: true,
        reasonCode: true,
        scoreAtDecision: true,
        formulaVersion: true,
        candidate: {
          select: { id: true, hostNormalized: true, acceptedOrganizationId: true },
        },
      },
    });

    console.log("Калибровочный отчёт Partner Score");
    console.log(`Решений с зафиксированным score: ${decisions.length}`);
    const formulaVersions = [
      ...new Set(decisions.map(({ formulaVersion }) => formulaVersion ?? "неизвестно")),
    ];
    if (formulaVersions.length > 0) {
      console.log(`Версии формулы: ${formulaVersions.join(", ")}`);
    }
    console.log("");

    if (decisions.length === 0) {
      console.log("Решений с score_at_decision пока нет — отчёт пуст.");
      return;
    }

    printScoreBuckets(decisions);
    printRejectReasons(decisions);
    await printPlacementFunnel(prisma, decisions);

    if (decisions.length < MIN_DECISIONS_FOR_CONCLUSIONS) {
      console.log(
        `Внимание: всего ${decisions.length} решений (< ${MIN_DECISIONS_FOR_CONCLUSIONS}) — мало данных для выводов.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

interface DecisionRow {
  decision: string;
  reasonCode: string | null;
  scoreAtDecision: number | null;
  candidate: { id: string; hostNormalized: string; acceptedOrganizationId: string | null };
}

function bucketOf(score: number) {
  return (
    SCORE_BUCKETS.find(({ min, max }) => score >= min && score <= max) ??
    SCORE_BUCKETS[SCORE_BUCKETS.length - 1]
  );
}

function printScoreBuckets(decisions: DecisionRow[]) {
  const rows = SCORE_BUCKETS.map((bucket) => {
    const inBucket = decisions.filter(
      ({ scoreAtDecision }) =>
        scoreAtDecision !== null && bucketOf(scoreAtDecision).label === bucket.label,
    );
    const accepts = inBucket.filter(({ decision }) => decision.toLowerCase() === "accept").length;
    return {
      bucket: bucket.label,
      total: String(inBucket.length),
      accepts: String(accepts),
      acceptShare: inBucket.length > 0 ? `${Math.round((accepts / inBucket.length) * 100)}%` : "—",
    };
  });
  console.log("Решения по бакетам score");
  printTable(
    ["Бакет", "Решений", "Accept", "% accept"],
    rows.map((row) => [row.bucket, row.total, row.accepts, row.acceptShare]),
  );
}

function printRejectReasons(decisions: DecisionRow[]) {
  const rejects = decisions.filter(({ decision }) => decision.toLowerCase() === "reject");
  console.log(`Причины отклонения (reject: ${rejects.length})`);
  if (rejects.length === 0) {
    console.log("  Отклонённых решений нет.");
    console.log("");
    return;
  }
  const counts = new Map<string, number>();
  for (const { reasonCode } of rejects) {
    const key = reasonCode ?? "(без кода)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([code, count]) => [
      REJECT_REASON_LABELS[code] ?? code,
      code,
      String(count),
      `${Math.round((count / rejects.length) * 100)}%`,
    ]);
  printTable(["Причина", "Код", "Решений", "Доля"], rows);
}

async function printPlacementFunnel(prisma: PrismaClient, decisions: DecisionRow[]) {
  const accepts = decisions.filter(({ decision }) => decision.toLowerCase() === "accept");
  console.log(`Accepted → Placement (accept: ${accepts.length})`);
  if (accepts.length === 0) {
    console.log("  Принятых решений нет.");
    console.log("");
    return;
  }

  // Primary link: accepted_organization_id from the accept transaction.
  // Fallback: match the candidate's normalized host against the Domain
  // registry — the only link left for records without the column.
  const hostsWithoutOrganization = [
    ...new Set(
      accepts
        .filter(({ candidate }) => !candidate.acceptedOrganizationId)
        .map(({ candidate }) => candidate.hostNormalized),
    ),
  ];
  const domainRows =
    hostsWithoutOrganization.length > 0
      ? await prisma.domain.findMany({
          where: { hostNormalized: { in: hostsWithoutOrganization }, archivedAt: null },
          select: { hostNormalized: true, organizationId: true },
        })
      : [];
  const organizationByHost = new Map(
    domainRows.map(({ hostNormalized, organizationId }) => [hostNormalized, organizationId]),
  );

  const organizationOf = (row: DecisionRow) =>
    row.candidate.acceptedOrganizationId ??
    organizationByHost.get(row.candidate.hostNormalized) ??
    null;

  const organizationIds = [
    ...new Set(accepts.map(organizationOf).filter((id): id is string => id !== null)),
  ];
  const placements =
    organizationIds.length > 0
      ? await prisma.placement.findMany({
          where: { organizationId: { in: organizationIds }, archivedAt: null },
          select: { organizationId: true },
        })
      : [];
  const organizationsWithPlacement = new Set(
    placements.map(({ organizationId }) => organizationId),
  );

  const rows = SCORE_BUCKETS.map((bucket) => {
    const inBucket = accepts.filter(
      ({ scoreAtDecision }) =>
        scoreAtDecision !== null && bucketOf(scoreAtDecision).label === bucket.label,
    );
    const placed = inBucket.filter((row) => {
      const organizationId = organizationOf(row);
      return organizationId !== null && organizationsWithPlacement.has(organizationId);
    }).length;
    return [
      bucket.label,
      String(inBucket.length),
      String(placed),
      inBucket.length > 0 ? `${Math.round((placed / inBucket.length) * 100)}%` : "—",
    ];
  });
  printTable(["Бакет", "Accept", "До размещения", "Доля"], rows);
}

/** Prints a plain space-aligned text table. */
function printTable(header: string[], rows: string[][]) {
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? "").length)),
  );
  const line = (row: string[]) =>
    "  " + row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  console.log(line(header));
  console.log("  " + widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
