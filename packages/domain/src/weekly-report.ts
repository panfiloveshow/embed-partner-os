import type { GenerateWeeklyReportCommand } from "@embed-os/contracts";
import { DomainRuleError } from "./task-completion.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const FORMULA_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface WeeklyReportPeriod {
  start: Date;
  end: Date;
}

export function parseGenerateWeeklyReportCommand(input: unknown): GenerateWeeklyReportCommand {
  if (!isRecord(input)) {
    throw reportValidationError({ command: "Передайте параметры недельного снимка" });
  }

  const periodStart = requiredText(input.periodStart, "periodStart");
  const period = weeklyReportPeriod(periodStart);
  const dataAsOf = requiredText(input.dataAsOf, "dataAsOf");
  if (!ISO_WITH_TIMEZONE.test(dataAsOf) || Number.isNaN(Date.parse(dataAsOf))) {
    throw reportValidationError({
      dataAsOf: "Укажите ISO 8601 дату и время с часовым поясом",
    });
  }
  const normalizedDataAsOf = new Date(dataAsOf).toISOString();
  if (new Date(normalizedDataAsOf) < period.end) {
    throw reportValidationError({
      dataAsOf: "Снимок можно публиковать не раньше окончания отчётной недели",
    });
  }

  const formulaVersion = requiredText(input.formulaVersion, "formulaVersion");
  if (!FORMULA_VERSION.test(formulaVersion)) {
    throw reportValidationError({
      formulaVersion: "Используйте 1–64 символа: латиница, цифры, точка, дефис или подчёркивание",
    });
  }

  return { periodStart, dataAsOf: normalizedDataAsOf, formulaVersion };
}

export function weeklyReportPeriod(periodStart: string): WeeklyReportPeriod {
  if (!DATE_ONLY.test(periodStart)) {
    throw reportValidationError({
      periodStart: "Укажите понедельник в формате YYYY-MM-DD",
    });
  }
  const start = new Date(`${periodStart}T00:00:00+03:00`);
  if (
    Number.isNaN(start.getTime()) ||
    formatMoscowDate(start) !== periodStart ||
    formatMoscowWeekday(start) !== "Mon"
  ) {
    throw reportValidationError({
      periodStart: "Отчётная неделя должна начинаться в понедельник по Europe/Moscow",
    });
  }
  return {
    start,
    end: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1_000 - 1),
  };
}

function formatMoscowWeekday(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    weekday: "short",
  }).format(date);
}

function formatMoscowDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw reportValidationError({ [field]: "Поле обязательно" });
  }
  return value.trim();
}

function reportValidationError(fieldErrors: Record<string, string>) {
  return new DomainRuleError(
    "ANL-009",
    "Некорректные параметры недельного отчёта",
    fieldErrors,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
