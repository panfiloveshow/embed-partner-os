import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Info, RefreshCw, UsersRound } from "lucide-react";
import type {
  WeeklyReportException,
  WeeklyReportMetric,
  WeeklyReportSnapshot,
} from "@embed-os/contracts";
import { ApiError, fetchLatestWeeklyReport, generateWeeklyReport } from "../lib/api";
import { defaultWeeklyReportCommand } from "../lib/reporting";
import { messageFor } from "../lib/problem";
import { createIdempotencyKey } from "../lib/idempotency";
import { formatDate, timeFormat } from "../lib/format";

interface WeeklyReportPageProps {
  teamName: string;
}

export function WeeklyReportPage({ teamName }: WeeklyReportPageProps) {
  const [snapshot, setSnapshot] = useState<WeeklyReportSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await fetchLatestWeeklyReport(signal));
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      if (loadError instanceof ApiError && loadError.problem.status === 404) {
        setSnapshot(null);
      } else {
        setError(messageFor(loadError));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      setSnapshot(await generateWeeklyReport(defaultWeeklyReportCommand(), createIdempotencyKey()));
    } catch (generateError) {
      setError(messageFor(generateError));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main className="main-area report-main">
      <header className="page-header report-page-header">
        <div>
          <h1>Недельный отчёт</h1>
          <p>{snapshot ? formatPeriod(snapshot) : "Последняя завершённая неделя"}</p>
        </div>
        <div className="header-actions">
          <label className="team-select">
            <UsersRound size={17} aria-hidden="true" />
            <span className="sr-only">Команда</span>
            <select value={teamName} disabled title="Мультикомандный режим появится позже">
              <option>{teamName}</option>
            </select>
          </label>
          <button
            className="button button-primary"
            type="button"
            onClick={() => void generate()}
            disabled={generating}
          >
            {generating ? "Формируем…" : "Сформировать снимок"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="report-error" role="alert">
          <span>{error}</span>
          <button className="button button-secondary" type="button" onClick={() => void load()}>
            <RefreshCw size={15} aria-hidden="true" />
            Повторить
          </button>
        </div>
      ) : null}

      {loading ? (
        <section className="report-loading" aria-live="polite">
          <span className="loader" aria-hidden="true" />
          <p>Загружаем опубликованный снимок…</p>
        </section>
      ) : snapshot ? (
        <WeeklyReportDashboard snapshot={snapshot} />
      ) : (
        <section className="report-empty-state">
          <RefreshCw size={34} aria-hidden="true" />
          <h2>Недельный снимок ещё не опубликован</h2>
          <p>Сформируйте первую ревизию за последнюю завершённую неделю.</p>
          <button
            className="button button-primary"
            type="button"
            onClick={() => void generate()}
            disabled={generating}
          >
            {generating ? "Формируем…" : "Сформировать снимок"}
          </button>
        </section>
      )}
    </main>
  );
}

function WeeklyReportDashboard({ snapshot }: { snapshot: WeeklyReportSnapshot }) {
  const [showAllExceptions, setShowAllExceptions] = useState(false);
  const maximumStageSize = useMemo(
    () => Math.max(1, ...snapshot.payload.funnel.stages.map(({ opportunities }) => opportunities)),
    [snapshot],
  );
  return (
    <section className="report-dashboard" aria-label="Опубликованный недельный отчёт">
      <div className="report-metadata">
        <span>
          Ревизия {snapshot.revision} <i aria-hidden="true">·</i> данные на{" "}
          {formatDataAsOf(snapshot.dataAsOf)} <i aria-hidden="true">·</i> формула{" "}
          {snapshot.formulaVersion}
        </span>
        <strong>
          <CheckCircle2 size={16} aria-hidden="true" />
          Опубликован
        </strong>
      </div>

      <section className="report-result-strip" aria-label="Результат недели">
        {snapshot.payload.result.map((metric) => (
          <ResultMetric metric={metric} key={metric.key} />
        ))}
      </section>

      <div className="report-middle-grid">
        <div className="report-left-stack">
          <section className="report-panel report-funnel">
            <h2>Воронка</h2>
            <div className="report-funnel-head" aria-hidden="true">
              <span>Стадия</span>
              <span>Партнёры</span>
              <span>Медианный возраст</span>
            </div>
            <div className="report-funnel-rows">
              {snapshot.payload.funnel.stages.map((stage) => (
                <div className="report-funnel-row" key={stage.code}>
                  <span>{stage.label}</span>
                  <span className="report-stage-count">
                    <i style={{ width: `${(stage.opportunities / maximumStageSize) * 100}%` }} />
                    <b>{stage.opportunities}</b>
                  </span>
                  <span>{stage.medianAgeDays === null ? "—" : `${stage.medianAgeDays} дн.`}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="report-panel report-execution">
            <h2>Исполнение</h2>
            <div className="report-execution-grid">
              <ExecutionMetric
                label="Покрытие следующими действиями"
                value={
                  snapshot.payload.execution.nextActionCoverage.percent === null
                    ? "—"
                    : `${snapshot.payload.execution.nextActionCoverage.percent}%`
                }
                detail={`${snapshot.payload.execution.nextActionCoverage.covered} / ${snapshot.payload.execution.nextActionCoverage.total} партнёров`}
              />
              <ExecutionMetric
                label="Выполнено задач"
                value={String(snapshot.payload.execution.completedTasks)}
                tone="positive"
              />
              <ExecutionMetric
                label="Просрочено задач"
                value={String(snapshot.payload.execution.overdueTasks)}
                tone="negative"
              />
            </div>
          </section>
        </div>

        <section className="report-panel report-decisions">
          <h2>Решения руководителя</h2>
          <div className="report-decision-head" aria-hidden="true">
            <span>Действие</span>
            <span>Затронутые</span>
            <span>Владелец</span>
            <span>Срок</span>
          </div>
          <div className="report-decision-list">
            {snapshot.payload.decisions.length > 0 ? (
              snapshot.payload.decisions.map((decision) => (
                <article key={decision.code}>
                  <p>{decision.question}</p>
                  <strong>{decision.affectedCount}</strong>
                  <span>{decision.owner}</span>
                  <time dateTime={decision.dueAt}>{formatDate(decision.dueAt)}</time>
                </article>
              ))
            ) : (
              <p className="report-no-decisions">Решения руководителя не требуются.</p>
            )}
          </div>
        </section>
      </div>

      <section className="report-panel report-exceptions">
        <div className="report-panel-heading">
          <h2>Исключения</h2>
          {snapshot.payload.exceptions.length > 4 ? (
            <button
              type="button"
              onClick={() => setShowAllExceptions((current) => !current)}
              aria-expanded={showAllExceptions}
            >
              {showAllExceptions
                ? "Показать первые 4"
                : `Показать все ${snapshot.payload.exceptions.length}`}
            </button>
          ) : null}
        </div>
        {snapshot.payload.exceptions.length > 0 ? (
          <div className="report-table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Партнёр</th>
                  <th>Риск</th>
                  <th>Владелец</th>
                  <th>Возраст</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {(showAllExceptions
                  ? snapshot.payload.exceptions
                  : snapshot.payload.exceptions.slice(0, 4)
                ).map((exception, index) => (
                  <ExceptionRow
                    exception={exception}
                    key={`${exception.opportunityId}:${exception.code}:${index}`}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="report-no-exceptions">Критических исключений нет.</p>
        )}
      </section>

      <footer className="report-data-quality">
        <Info size={18} aria-hidden="true" />
        <span>{snapshot.payload.dataQuality.notes.join(" ")}</span>
      </footer>
    </section>
  );
}

function ResultMetric({ metric }: { metric: WeeklyReportMetric }) {
  return (
    <div className="report-result-metric">
      <span>{metricLabel(metric)}</span>
      <strong>{metric.value ?? "—"}</strong>
      <small
        className={
          metric.changeVsPreviousWeek !== null && metric.changeVsPreviousWeek > 0 ? "positive" : ""
        }
      >
        {metric.value === null ? "нет данных" : formatChange(metric.changeVsPreviousWeek)}
      </small>
    </div>
  );
}

function metricLabel(metric: WeeklyReportMetric) {
  const labels: Record<WeeklyReportMetric["key"], string> = {
    discovered: "Найдено",
    qualified: "Квалифицировано",
    dialogues: "В диалоге",
    integrations: "Интеграции",
    pilots: "Пилоты",
    activeLaunches: "Активные запуски",
  };
  return labels[metric.key];
}

function ExecutionMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function ExceptionRow({ exception }: { exception: WeeklyReportException }) {
  return (
    <tr>
      <td data-label="Партнёр">
        <strong>{exception.organizationName}</strong>
      </td>
      <td data-label="Риск">{exception.title}</td>
      <td data-label="Владелец">{exception.ownerName}</td>
      <td data-label="Возраст">
        <span className={`report-age report-age-${exception.severity}`}>
          {exception.ageDays} дн.
        </span>
      </td>
      <td data-label="Действие">{actionFor(exception)}</td>
    </tr>
  );
}

function actionFor(exception: WeeklyReportException) {
  if (exception.code === "overdue-task") return "Уточнить срок или перераспределить";
  if (exception.code === "missing-next-action") return "Назначить следующее действие";
  if (exception.code === "sla-escalation") return "Принять решение и назначить владельца";
  return "Продолжить, поставить на паузу или закрыть";
}

function formatPeriod(snapshot: WeeklyReportSnapshot) {
  const start = new Date(snapshot.periodStart);
  const end = new Date(snapshot.periodEnd);
  const startDay = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
  }).format(start);
  const endPart = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(end);
  return `${startDay}–${endPart.replace(/\s*г\.$/, "")}`;
}

function formatDataAsOf(value: string) {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
  }).format(date);
  return `${day}, ${timeFormat.format(date)}`;
}

function formatChange(value: number | null) {
  if (value === null) return "нет сравнения";
  if (value > 0) return `+${value} к прошлой неделе`;
  if (value < 0) return `${value} к прошлой неделе`;
  return "±0 к прошлой неделе";
}
