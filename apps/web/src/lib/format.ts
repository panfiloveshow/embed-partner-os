const MOSCOW_TIME_ZONE = "Europe/Moscow";

/** 17.08.2026 */
export const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** 17.08.2026, 12:00 */
export const dateTimeFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** 12:00 */
export const timeFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

/** 17 авг., 12:00 */
export const shortDateTimeFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** 17 авг. 2026 г., 12:00 */
export const mediumDateTimeFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

/** понедельник, 17 августа */
export const longDateFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** 17.08 */
export const dayMonthFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
});

/** 17.08, 12:00 */
export const dayMonthTimeFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: string): string {
  return dateFormat.format(new Date(value));
}

export function formatDateTime(value: string): string {
  return dateTimeFormat.format(new Date(value));
}

export function formatTime(value: string): string {
  return timeFormat.format(new Date(value));
}
