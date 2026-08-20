import { ApiError } from "./api";

export function messageFor(error: unknown, fallback = "Неизвестная ошибка"): string {
  if (error instanceof ApiError) {
    const candidates = error.problem.duplicateCandidates;
    if (candidates?.length) {
      return `${error.problem.detail} Кандидаты: ${candidates.map(({ fullName }) => fullName).join(", ")}.`;
    }
    const fieldErrors = error.problem.fieldErrors;
    return fieldErrors && Object.keys(fieldErrors).length > 0
      ? `${error.problem.detail}: ${Object.values(fieldErrors).join("; ")}.`
      : error.problem.detail;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}
