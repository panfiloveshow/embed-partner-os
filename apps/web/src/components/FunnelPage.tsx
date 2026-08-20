import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CircleAlert,
  Columns3,
  List,
  RefreshCw,
  Search,
  UsersRound,
} from "lucide-react";
import {
  opportunityStageCatalog,
  type FunnelOpportunity,
  type FunnelPayload,
  type OpportunityRiskFlag,
} from "@embed-os/contracts";
import { ApiError, fetchFunnel } from "../lib/api";
import {
  filterFunnel,
  summarizeFunnel,
  type FunnelFilters,
} from "../lib/funnel";

interface FunnelPageProps {
  teamName: string;
  onOpenOpportunity: (opportunityId: string) => void;
}

const defaultFilters: FunnelFilters = {
  query: "",
  stageCode: "all",
  ownerId: "all",
  risk: "all",
};

const riskLabels: Record<OpportunityRiskFlag, string> = {
  overdue: "Просрочено",
  "missing-next-action": "Нет следующего шага",
  waiting: "Ожидание",
  "technical-risk": "Технический риск",
};

export function FunnelPage({ teamName, onOpenOpportunity }: FunnelPageProps) {
  const [payload, setPayload] = useState<FunnelPayload | null>(null);
  const [view, setView] = useState<"kanban" | "table">("kanban");
  const [filters, setFilters] = useState<FunnelFilters>(defaultFilters);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setPayload(await fetchFunnel(signal));
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(messageFor(loadError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const opportunities = payload?.opportunities ?? [];
  const filtered = useMemo(
    () => filterFunnel(opportunities, filters),
    [opportunities, filters],
  );
  const summary = useMemo(() => summarizeFunnel(opportunities), [opportunities]);
  const owners = useMemo(() => [...new Map(
    opportunities.map(({ owner }) => [owner.id, owner]),
  ).values()].sort((left, right) => left.name.localeCompare(right.name, "ru")), [opportunities]);
  const visibleStages = opportunityStageCatalog.filter((stage) =>
    opportunities.some(({ stageCode }) => stageCode === stage.code) ||
    filters.stageCode === stage.code,
  );
  const hasFilters = Object.entries(filters).some(([key, value]) =>
    key === "query" ? value !== "" : value !== "all",
  );

  return (
    <main className="main-area funnel-main">
      <header className="page-header funnel-page-header">
        <div>
          <h1>Воронка</h1>
          <p>
            {payload
              ? `${payload.total} возможностей · процесс v${payload.processVersions.join(", ") || "—"}`
              : "Единый обзор движения партнёров"}
          </p>
        </div>
        <div className="header-actions funnel-header-actions">
          <label className="team-select">
            <UsersRound size={17} aria-hidden="true" />
            <span className="sr-only">Команда</span>
            <select value={payload?.teamName ?? teamName} onChange={() => undefined}>
              <option>{payload?.teamName ?? teamName}</option>
            </select>
          </label>
          <div className="funnel-view-toggle" role="group" aria-label="Представление воронки">
            <button
              type="button"
              aria-pressed={view === "kanban"}
              onClick={() => setView("kanban")}
            >
              <Columns3 size={16} aria-hidden="true" />
              Канбан
            </button>
            <button
              type="button"
              aria-pressed={view === "table"}
              onClick={() => setView("table")}
            >
              <List size={16} aria-hidden="true" />
              Таблица
            </button>
          </div>
        </div>
      </header>

      <section className="funnel-summary" aria-label="Состояние воронки">
        <SummaryMetric label="Активные" value={summary.active} tone="active" />
        <SummaryMetric label="Просрочены" value={summary.overdue} tone="overdue" />
        <SummaryMetric label="Без следующего шага" value={summary.missingNextAction} tone="missing" />
        <SummaryMetric label="Технический риск" value={summary.technicalRisk} tone="technical" />
      </section>

      <section className="funnel-toolbar" aria-label="Фильтры воронки">
        <label className="funnel-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Поиск по партнёру, домену или действию</span>
          <input
            type="search"
            value={filters.query}
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            placeholder="Партнёр, домен или действие"
          />
        </label>
        <label>
          <span className="sr-only">Стадия</span>
          <select
            aria-label="Стадия"
            value={filters.stageCode}
            onChange={(event) => setFilters((current) => ({
              ...current,
              stageCode: event.target.value as FunnelFilters["stageCode"],
            }))}
          >
            <option value="all">Все стадии</option>
            {opportunityStageCatalog.map(({ code, label }) => (
              <option key={code} value={code}>{code} · {label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Ответственный</span>
          <select
            aria-label="Ответственный"
            value={filters.ownerId}
            onChange={(event) => setFilters((current) => ({
              ...current,
              ownerId: event.target.value,
            }))}
          >
            <option value="all">Все ответственные</option>
            {owners.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Риск</span>
          <select
            aria-label="Риск"
            value={filters.risk}
            onChange={(event) => setFilters((current) => ({
              ...current,
              risk: event.target.value as FunnelFilters["risk"],
            }))}
          >
            <option value="all">Все риски</option>
            {Object.entries(riskLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        {hasFilters ? (
          <button className="funnel-clear" type="button" onClick={() => setFilters(defaultFilters)}>
            Сбросить
          </button>
        ) : null}
      </section>

      {error ? (
        <section className="funnel-state funnel-state-error" role="alert">
          <CircleAlert size={28} aria-hidden="true" />
          <h2>Не удалось загрузить воронку</h2>
          <p>{error}</p>
          <button className="button button-secondary" type="button" onClick={() => void load()}>
            <RefreshCw size={16} aria-hidden="true" />
            Повторить
          </button>
        </section>
      ) : loading ? (
        <section className="funnel-state" aria-live="polite">
          <span className="loader" aria-hidden="true" />
          <p>Собираем воронку…</p>
        </section>
      ) : filtered.length === 0 ? (
        <section className="funnel-state">
          <Search size={28} aria-hidden="true" />
          <h2>Ничего не найдено</h2>
          <p>Измените фильтры или очистите поиск.</p>
          {hasFilters ? (
            <button className="button button-secondary" type="button" onClick={() => setFilters(defaultFilters)}>
              Сбросить фильтры
            </button>
          ) : null}
        </section>
      ) : view === "kanban" ? (
        <section className="funnel-board" aria-label="Канбан воронки">
          {visibleStages.map((stage) => {
            const items = filtered.filter(({ stageCode }) => stageCode === stage.code);
            if (filters.stageCode === "all" && items.length === 0) return null;
            const totalAtStage = payload?.stageCounts.find(({ code }) => code === stage.code)?.count ?? 0;
            return (
              <section className="funnel-column" key={stage.code} aria-labelledby={`stage-${stage.code}`}>
                <header>
                  <span className="funnel-stage-code">{stage.code}</span>
                  <h2 id={`stage-${stage.code}`}>{stage.label}</h2>
                  <span className="funnel-stage-count" aria-label={`${items.length} из ${totalAtStage}`}>
                    {hasFilters ? `${items.length}/${totalAtStage}` : totalAtStage}
                  </span>
                </header>
                <div className="funnel-card-list">
                  {items.length > 0 ? items.map((opportunity) => (
                    <OpportunityCard
                      key={opportunity.id}
                      opportunity={opportunity}
                      onOpen={onOpenOpportunity}
                    />
                  )) : <p className="funnel-column-empty">Нет возможностей</p>}
                </div>
              </section>
            );
          })}
        </section>
      ) : (
        <FunnelTable opportunities={filtered} onOpen={onOpenOpportunity} />
      )}

      {payload?.truncated ? (
        <p className="funnel-limit-note" role="status">
          Показаны первые 200 возможностей. Счётчики стадий рассчитаны по всей команде.
        </p>
      ) : null}
    </main>
  );
}

function SummaryMetric({
  label,
  value,
  tone,
}: { label: string; value: number; tone: string }) {
  return (
    <article className={`funnel-summary-item funnel-summary-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function OpportunityCard({
  opportunity,
  onOpen,
}: { opportunity: FunnelOpportunity; onOpen: (id: string) => void }) {
  return (
    <article className="funnel-card">
      <div className="funnel-card-heading">
        <div>
          <strong>{opportunity.organizationName}</strong>
          <span>{opportunity.domain}</span>
        </div>
        <span className="funnel-score" aria-label={`Скор ${opportunity.partnerScore}`}>
          {opportunity.partnerScore}
        </span>
      </div>
      <div className="funnel-owner">
        <span className="funnel-owner-avatar" aria-hidden="true">{initials(opportunity.owner.name)}</span>
        <span>{opportunity.owner.name}</span>
        {opportunity.stageAgeDays !== null ? <small>{opportunity.stageAgeDays} дн. на стадии</small> : null}
      </div>
      <div className="funnel-next-action">
        <span>Следующее действие</span>
        {opportunity.nextAction ? (
          <>
            <strong>{opportunity.nextAction.title}</strong>
            <time dateTime={opportunity.nextAction.dueAt}>{formatDate(opportunity.nextAction.dueAt)}</time>
          </>
        ) : <strong className="funnel-no-action">Не назначено</strong>}
      </div>
      <RiskBadges flags={opportunity.riskFlags} />
      <button className="funnel-open-button" type="button" onClick={() => onOpen(opportunity.id)}>
        Открыть в «Сегодня»
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </article>
  );
}

function FunnelTable({
  opportunities,
  onOpen,
}: { opportunities: FunnelOpportunity[]; onOpen: (id: string) => void }) {
  return (
    <section className="funnel-table-frame" aria-label="Таблица воронки">
      <div className="funnel-table-scroll">
        <table className="funnel-table">
          <thead>
            <tr>
              <th>Партнёр</th>
              <th>Стадия</th>
              <th>Скор</th>
              <th>Ответственный</th>
              <th>Следующее действие</th>
              <th>Риски</th>
              <th><span className="sr-only">Действие</span></th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((opportunity) => (
              <tr key={opportunity.id}>
                <td data-label="Партнёр">
                  <strong>{opportunity.organizationName}</strong>
                  <small>{opportunity.domain}</small>
                </td>
                <td data-label="Стадия">
                  <span className="funnel-table-stage">{opportunity.stageCode}</span>
                  {opportunity.stageLabel}
                </td>
                <td data-label="Скор"><span className="funnel-score">{opportunity.partnerScore}</span></td>
                <td data-label="Ответственный">{opportunity.owner.name}</td>
                <td data-label="Следующее действие">
                  {opportunity.nextAction ? (
                    <>
                      <strong>{opportunity.nextAction.title}</strong>
                      <time dateTime={opportunity.nextAction.dueAt}>
                        {formatDate(opportunity.nextAction.dueAt)}
                      </time>
                    </>
                  ) : <span className="funnel-no-action">Не назначено</span>}
                </td>
                <td data-label="Риски"><RiskBadges flags={opportunity.riskFlags} /></td>
                <td>
                  <button
                    className="funnel-table-open"
                    type="button"
                    onClick={() => onOpen(opportunity.id)}
                    aria-label={`Открыть ${opportunity.organizationName} в Сегодня`}
                  >
                    <ArrowRight size={16} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RiskBadges({ flags }: { flags: OpportunityRiskFlag[] }) {
  if (flags.length === 0) return <span className="funnel-risk-none">Без рисков</span>;
  return (
    <div className="funnel-risks">
      {flags.map((flag) => (
        <span className={`funnel-risk funnel-risk-${flag}`} key={flag}>
          {flag === "overdue" || flag === "technical-risk"
            ? <AlertTriangle size={11} aria-hidden="true" />
            : null}
          {riskLabels[flag]}
        </span>
      ))}
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase("ru");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function messageFor(error: unknown) {
  if (error instanceof ApiError) return error.problem.detail;
  if (error instanceof Error) return error.message;
  return "Неизвестная ошибка";
}
