import type { AppPage } from "../components/Sidebar";

export const routablePages: readonly AppPage[] = [
  "today",
  "partners",
  "funnel",
  "radar",
  "placements",
  "reports",
  "settings",
];

/** Возвращает страницу приложения по location.hash; неизвестный путь ведёт на «Сегодня». */
export function pageFromHash(hash: string): AppPage {
  const candidate = hash.replace(/^#\/?/, "");
  return (routablePages as readonly string[]).includes(candidate)
    ? (candidate as AppPage)
    : "today";
}
