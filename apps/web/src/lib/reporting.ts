import type { GenerateWeeklyReportCommand } from "@embed-os/contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export function defaultWeeklyReportCommand(now = new Date()): GenerateWeeklyReportCommand {
  const localDate = formatMoscowDate(now);
  const localNoon = new Date(`${localDate}T12:00:00+03:00`);
  const daysSinceMonday = (localNoon.getUTCDay() + 6) % 7;
  const currentMonday = new Date(
    new Date(`${localDate}T00:00:00+03:00`).getTime() - daysSinceMonday * DAY_MS,
  );
  const previousMonday = new Date(currentMonday.getTime() - 7 * DAY_MS);
  return {
    periodStart: formatMoscowDate(previousMonday),
    dataAsOf: now.toISOString(),
    formulaVersion: "weekly-v1",
  };
}

function formatMoscowDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
