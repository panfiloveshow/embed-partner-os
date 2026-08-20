import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  Clock3,
  ExternalLink,
  History,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  TriangleAlert,
  UsersRound,
  X,
} from "lucide-react";
import type {
  ArchivePlacementCommand,
  HealthCheckView,
  PlacementHealthStatus,
  PlacementView,
  RegisterPlacementCommand,
  UpdatePlacementCommand,
} from "@embed-os/contracts";
import {
  ApiError,
  archivePlacement,
  fetchPlacementChecks,
  fetchPlacements,
  registerPlacement,
  runPlacementL0Check,
  updatePlacement,
} from "../lib/api";
import {
  filterPlacements,
  sortPlacementChecks,
  summarizePlacements,
  type PlacementFilters,
} from "../lib/placements";
import { messageFor } from "../lib/problem";
import { createIdempotencyKey, mutationKey, type MutationKeyState } from "../lib/idempotency";
import {
  dateFormat,
  formatDate as formatDateOnly,
  formatDateTime,
  formatTime,
} from "../lib/format";
import { AddPlacementDialog, type PlacementContextOption } from "./AddPlacementDialog";
import { PlacementLifecycleDialog } from "./PlacementLifecycleDialog";

interface PlacementPageProps {
  teamName: string;
  contexts: PlacementContextOption[];
}

const defaultFilters: PlacementFilters = {
  query: "",
  status: "all",
  environment: "all",
};

export function PlacementPage({ teamName, contexts }: PlacementPageProps) {
  const [placements, setPlacements] = useState<PlacementView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checks, setChecks] = useState<HealthCheckView[]>([]);
  const [loading, setLoading] = useState(true);
  const [checksLoading, setChecksLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<PlacementFilters>(defaultFilters);
  const [addOpen, setAddOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const registrationMutation = useRef<MutationKeyState | null>(null);
  const checkKeys = useRef(new Map<string, string>());
  const lifecycleMutation = useRef<MutationKeyState | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const next = sortPlacements(await fetchPlacements(signal));
      setPlacements(next);
      setSelectedId((current) =>
        current && next.some(({ id }) => id === current) ? current : (next[0]?.id ?? null),
      );
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(messageFor(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setChecks([]);
      return;
    }
    const controller = new AbortController();
    setChecksLoading(true);
    setActionError(null);
    void fetchPlacementChecks(selectedId, controller.signal)
      .then((history) => setChecks(sortPlacementChecks(history)))
      .catch((historyError) => {
        if (historyError instanceof DOMException && historyError.name === "AbortError") return;
        setActionError(messageFor(historyError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecksLoading(false);
      });
    return () => controller.abort();
  }, [selectedId]);

  const selected = placements.find(({ id }) => id === selectedId) ?? null;
  const summary = useMemo(() => summarizePlacements(placements), [placements]);
  const filtered = useMemo(() => filterPlacements(placements, filters), [placements, filters]);

  async function runCheck(placementId: string) {
    let idempotencyKey = checkKeys.current.get(placementId);
    if (!idempotencyKey) {
      idempotencyKey = createIdempotencyKey("placement-check");
      checkKeys.current.set(placementId, idempotencyKey);
    }
    setSelectedId(placementId);
    setCheckingId(placementId);
    setActionError(null);
    setNotice(null);
    try {
      const result = await runPlacementL0Check(placementId, idempotencyKey);
      setPlacements((current) =>
        current.map((placement) =>
          placement.id === result.placement.id ? result.placement : placement,
        ),
      );
      setChecks((current) =>
        sortPlacementChecks([result.check, ...current.filter(({ id }) => id !== result.check.id)]),
      );
      setNotice(checkNotice(result.placement, result.alertChange));
      checkKeys.current.delete(placementId);
    } catch (checkError) {
      setActionError(messageFor(checkError));
    } finally {
      setCheckingId(null);
    }
  }

  function openRegistration() {
    registrationMutation.current = null;
    setRegistrationError(null);
    setAddOpen(true);
  }

  function closeRegistration() {
    if (registering) return;
    registrationMutation.current = null;
    setRegistrationError(null);
    setAddOpen(false);
  }

  async function submitRegistration(command: RegisterPlacementCommand) {
    const key = mutationKey(registrationMutation, command, "placement-register");
    setRegistering(true);
    setRegistrationError(null);
    try {
      const created = await registerPlacement(command, key);
      setPlacements((current) => sortPlacements([...current, created]));
      setSelectedId(created.id);
      setChecks([]);
      setNotice(`Размещение ${created.organizationName} добавлено в мониторинг.`);
      registrationMutation.current = null;
      setAddOpen(false);
    } catch (registerError) {
      setRegistrationError(messageFor(registerError));
    } finally {
      setRegistering(false);
    }
  }

  function openLifecycle() {
    lifecycleMutation.current = null;
    setLifecycleError(null);
    setLifecycleOpen(true);
  }

  function closeLifecycle() {
    if (lifecycleBusy) return;
    lifecycleMutation.current = null;
    setLifecycleError(null);
    setLifecycleOpen(false);
  }

  async function submitLifecycle(command: UpdatePlacementCommand) {
    if (!selected) return;
    const key = mutationKey(lifecycleMutation, command, "placement-update");
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      const updated = await updatePlacement(selected.id, command, key);
      setPlacements((current) =>
        sortPlacements(
          current.map((placement) => (placement.id === updated.id ? updated : placement)),
        ),
      );
      setNotice(
        `Размещение ${updated.organizationName} обновлено: ${businessStatusLabel(updated.businessStatus)}.`,
      );
      lifecycleMutation.current = null;
      setLifecycleOpen(false);
    } catch (updateError) {
      if (isPlacementVersionConflict(updateError)) {
        setLifecycleOpen(false);
        setActionError("Размещение уже изменилось. Реестр обновлён — откройте форму ещё раз.");
        await load();
      } else {
        setLifecycleError(messageFor(updateError));
      }
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function submitArchive(command: ArchivePlacementCommand) {
    if (!selected) return;
    const key = mutationKey(lifecycleMutation, command, "placement-archive");
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      const archived = await archivePlacement(selected.id, command, key);
      const remaining = placements.filter(({ id }) => id !== archived.id);
      setPlacements(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setNotice(`Размещение ${archived.organizationName} архивировано, мониторинг остановлен.`);
      lifecycleMutation.current = null;
      setLifecycleOpen(false);
    } catch (archiveError) {
      if (isPlacementVersionConflict(archiveError)) {
        setLifecycleOpen(false);
        setActionError("Размещение уже изменилось. Реестр обновлён — повторите архивирование.");
        await load();
      } else {
        setLifecycleError(messageFor(archiveError));
      }
    } finally {
      setLifecycleBusy(false);
    }
  }

  return (
    <main className="main-area placement-main">
      <header className="page-header placement-page-header">
        <div>
          <h1>Размещения</h1>
          <p>Контроль работоспособности эмбедов</p>
        </div>
        <div className="header-actions">
          <label className="team-select">
            <UsersRound size={17} aria-hidden="true" />
            <span className="sr-only">Команда</span>
            <select value={teamName} disabled title="Мультикомандный режим появится позже">
              <option>{teamName}</option>
            </select>
          </label>
          <button className="button button-primary" type="button" onClick={openRegistration}>
            <Plus size={17} aria-hidden="true" />
            Добавить размещение
          </button>
        </div>
      </header>

      {notice ? (
        <div className="operation-notice placement-notice" role="status">
          <CheckCircle2 size={17} aria-hidden="true" />
          <span>{notice}</span>
          <button
            className="icon-button"
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Скрыть уведомление"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <section className="placement-workspace">
        <div className="placement-work-columns">
          <div className="placement-registry-pane">
            <PlacementSummary summary={summary} />
            <PlacementFiltersBar filters={filters} onChange={setFilters} onAdd={openRegistration} />

            {actionError ? (
              <div className="placement-inline-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{actionError}</span>
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  aria-label="Скрыть ошибку"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {loading ? (
              <div className="placement-state" aria-live="polite">
                <span className="loader" aria-hidden="true" />
                <p>Загружаем реестр размещений…</p>
              </div>
            ) : error ? (
              <div className="placement-state placement-state-error" role="alert">
                <AlertCircle size={30} aria-hidden="true" />
                <h2>Не удалось загрузить размещения</h2>
                <p>{error}</p>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => void load()}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                  Повторить
                </button>
              </div>
            ) : filtered.length > 0 ? (
              <PlacementTable
                placements={filtered}
                selectedId={selectedId}
                checkingId={checkingId}
                onSelect={setSelectedId}
                onRunCheck={(id) => void runCheck(id)}
              />
            ) : (
              <div className="placement-state">
                <CircleHelp size={30} aria-hidden="true" />
                <h2>{placements.length > 0 ? "Ничего не найдено" : "Размещений пока нет"}</h2>
                <p>
                  {placements.length > 0
                    ? "Измените строку поиска или фильтры."
                    : "Добавьте страницу партнёра, чтобы включить L0-мониторинг."}
                </p>
                {placements.length === 0 ? (
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={openRegistration}
                  >
                    <Plus size={16} aria-hidden="true" />
                    Добавить размещение
                  </button>
                ) : null}
              </div>
            )}
          </div>

          {selected ? (
            <button
              className="placement-drawer-backdrop"
              type="button"
              onClick={() => setSelectedId(null)}
              aria-label="Закрыть карточку размещения"
            />
          ) : null}
          <PlacementDetail
            placement={selected}
            checks={checks}
            checksLoading={checksLoading}
            checking={selected ? checkingId === selected.id : false}
            onClose={() => setSelectedId(null)}
            onRunCheck={(id) => void runCheck(id)}
            onManage={openLifecycle}
          />
        </div>
      </section>

      {addOpen ? (
        <AddPlacementDialog
          contexts={contexts}
          busy={registering}
          error={registrationError}
          onCancel={closeRegistration}
          onSubmit={submitRegistration}
        />
      ) : null}

      {lifecycleOpen && selected ? (
        <PlacementLifecycleDialog
          placement={selected}
          busy={lifecycleBusy}
          error={lifecycleError}
          onCancel={closeLifecycle}
          onSubmit={submitLifecycle}
          onArchive={submitArchive}
        />
      ) : null}
    </main>
  );
}

function PlacementSummary({ summary }: { summary: ReturnType<typeof summarizePlacements> }) {
  const items = [
    { label: "Активные", value: summary.active, tone: "active", icon: CheckCircle2 },
    { label: "Работают", value: summary.healthy, tone: "healthy", icon: Clock3 },
    { label: "Требуют внимания", value: summary.attention, tone: "attention", icon: TriangleAlert },
    { label: "Не проверено", value: summary.unchecked, tone: "unchecked", icon: CircleHelp },
  ];
  return (
    <section className="placement-summary" aria-label="Сводка по размещениям">
      {items.map(({ label, value, tone, icon: Icon }) => (
        <div className={`placement-summary-item placement-summary-${tone}`} key={label}>
          <Icon size={27} strokeWidth={1.8} aria-hidden="true" />
          <span>
            {label}
            <strong>{value}</strong>
          </span>
        </div>
      ))}
    </section>
  );
}

function PlacementFiltersBar({
  filters,
  onChange,
  onAdd,
}: {
  filters: PlacementFilters;
  onChange: (filters: PlacementFilters) => void;
  onAdd: () => void;
}) {
  return (
    <div className="placement-filters" aria-label="Фильтры размещений">
      <label className="placement-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Партнёр или URL</span>
        <input
          type="search"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          placeholder="Партнёр или URL"
        />
      </label>
      <label>
        <span className="sr-only">Статус здоровья</span>
        <select
          value={filters.status}
          onChange={(event) =>
            onChange({
              ...filters,
              status: event.target.value as PlacementFilters["status"],
            })
          }
        >
          <option value="all">Все статусы</option>
          <option value="healthy">Работает</option>
          <option value="degraded">Деградация</option>
          <option value="failed">Ошибка</option>
          <option value="unchecked">Не проверено</option>
          <option value="awaiting_fix">Ожидает исправления</option>
          <option value="disabled">Отключено</option>
          <option value="exception">Исключение</option>
        </select>
      </label>
      <label className="placement-environment-filter">
        <span className="sr-only">Среда</span>
        <select
          value={filters.environment}
          onChange={(event) =>
            onChange({
              ...filters,
              environment: event.target.value as PlacementFilters["environment"],
            })
          }
        >
          <option value="all">Все среды</option>
          <option value="production">Production</option>
          <option value="staging">Staging</option>
          <option value="test">Test</option>
        </select>
      </label>
      <button className="button button-primary placement-mobile-add" type="button" onClick={onAdd}>
        <Plus size={16} aria-hidden="true" />
        Добавить
      </button>
    </div>
  );
}

function PlacementTable({
  placements,
  selectedId,
  checkingId,
  onSelect,
  onRunCheck,
}: {
  placements: PlacementView[];
  selectedId: string | null;
  checkingId: string | null;
  onSelect: (id: string) => void;
  onRunCheck: (id: string) => void;
}) {
  return (
    <div className="placement-table-scroll">
      <table className="placement-table">
        <thead>
          <tr>
            <th>Партнёр</th>
            <th>Страница</th>
            <th>Среда</th>
            <th>Статус</th>
            <th>Последняя проверка</th>
            <th>Следующая</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          {placements.map((placement) => (
            <tr
              className={placement.id === selectedId ? "placement-row selected" : "placement-row"}
              key={placement.id}
              tabIndex={0}
              onClick={() => onSelect(placement.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(placement.id);
                }
              }}
            >
              <td data-label="Партнёр">
                <button
                  className="placement-partner-button"
                  type="button"
                  onClick={() => onSelect(placement.id)}
                >
                  {placement.organizationName}
                </button>
              </td>
              <td data-label="Страница">
                <span className="placement-url">{displayUrl(placement.pageUrl)}</span>
              </td>
              <td data-label="Среда">
                <span className="placement-environment">{placement.environment}</span>
              </td>
              <td data-label="Статус">
                <HealthStatus status={placement.healthStatus} />
              </td>
              <td data-label="Последняя проверка">{formatMoment(placement.lastCheckAt)}</td>
              <td
                data-label="Следующая"
                className={placement.healthStatus === "failed" ? "placement-next-critical" : ""}
              >
                {formatMoment(placement.nextCheckAt)}
              </td>
              <td data-label="Действия">
                <div className="placement-row-actions">
                  <a
                    href={placement.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Открыть страницу ${placement.organizationName}`}
                  >
                    <ExternalLink size={15} aria-hidden="true" />
                  </a>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(placement.id);
                    }}
                    aria-label={`Показать историю ${placement.organizationName}`}
                  >
                    <History size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRunCheck(placement.id);
                    }}
                    disabled={checkingId === placement.id || placement.businessStatus !== "active"}
                    aria-label={`Запустить L0-проверку ${placement.organizationName}`}
                  >
                    {checkingId === placement.id ? (
                      <RefreshCw className="spin-icon" size={15} aria-hidden="true" />
                    ) : (
                      <Play size={15} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlacementDetail({
  placement,
  checks,
  checksLoading,
  checking,
  onClose,
  onRunCheck,
  onManage,
}: {
  placement: PlacementView | null;
  checks: HealthCheckView[];
  checksLoading: boolean;
  checking: boolean;
  onClose: () => void;
  onRunCheck: (id: string) => void;
  onManage: () => void;
}) {
  if (!placement) {
    return (
      <aside className="placement-detail placement-detail-empty">
        <Activity size={28} aria-hidden="true" />
        <p>Выберите размещение, чтобы увидеть состояние и историю проверок.</p>
      </aside>
    );
  }
  return (
    <aside className="placement-detail" aria-label={`Размещение ${placement.organizationName}`}>
      <div className="placement-drawer-handle" aria-hidden="true" />
      <header className="placement-detail-header">
        <div>
          <h2>{placement.organizationName}</h2>
          <HealthStatus status={placement.healthStatus} compact />
        </div>
        <button
          className="placement-detail-close"
          type="button"
          onClick={onClose}
          aria-label="Закрыть карточку"
        >
          <X size={19} aria-hidden="true" />
        </button>
      </header>
      <a
        className="placement-mobile-detail-url"
        href={placement.pageUrl}
        target="_blank"
        rel="noreferrer"
      >
        {displayUrl(placement.pageUrl)} <ExternalLink size={13} aria-hidden="true" />
      </a>

      <DetailSection title="Информация о размещении">
        <dl className="placement-facts">
          <div>
            <dt>URL страницы</dt>
            <dd>
              <a href={placement.pageUrl} target="_blank" rel="noreferrer">
                {displayUrl(placement.pageUrl)} <ExternalLink size={13} aria-hidden="true" />
              </a>
            </dd>
          </div>
          <div>
            <dt>Тип контента</dt>
            <dd>{embedTypeLabel(placement.embedType)}</dd>
          </div>
          <div>
            <dt>Среда</dt>
            <dd>{capitalize(placement.environment)}</dd>
          </div>
          <div>
            <dt>Бизнес-статус</dt>
            <dd>{businessStatusLabel(placement.businessStatus)}</dd>
          </div>
          <div>
            <dt>Дата запуска</dt>
            <dd>{formatDate(placement.launchedAt)}</dd>
          </div>
        </dl>
      </DetailSection>

      <DetailSection title="Состояние здоровья">
        <dl className="placement-facts">
          <div>
            <dt>Последовательные сбои</dt>
            <dd>
              {placement.consecutiveFailures > 0
                ? `${placement.consecutiveFailures} подряд`
                : "Нет"}
            </dd>
          </div>
          <div>
            <dt>Последняя проверка</dt>
            <dd>{formatMoment(placement.lastCheckAt)}</dd>
          </div>
          <div>
            <dt>Результат</dt>
            <dd>{placement.lastCheck?.errorCode ?? healthLabel(placement.healthStatus)}</dd>
          </div>
        </dl>

        {placement.activeAlert ? (
          <div className="placement-active-alert">
            <AlertCircle size={17} aria-hidden="true" />
            <div>
              <strong>Активное техническое оповещение</strong>
              <span>Плеер не найден на странице или не инициализирован.</span>
              <a href={placement.pageUrl} target="_blank" rel="noreferrer">
                Исправить RUTUBE embed <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
          </div>
        ) : null}
      </DetailSection>

      <div className="placement-detail-actions">
        <button className="button button-secondary" type="button" onClick={onManage}>
          <Settings2 size={16} aria-hidden="true" />
          Управление
        </button>
        <button
          className="button button-primary placement-run-button"
          type="button"
          onClick={() => onRunCheck(placement.id)}
          disabled={checking || placement.businessStatus !== "active"}
        >
          {checking ? (
            <>
              <RefreshCw className="spin-icon" size={17} aria-hidden="true" />
              Проверяем…
            </>
          ) : (
            <>
              <Play size={17} aria-hidden="true" />
              Запустить L0-проверку
            </>
          )}
        </button>
      </div>

      <DetailSection title="История проверок" className="placement-history-section">
        {checksLoading ? (
          <p className="placement-history-loading">Загружаем историю…</p>
        ) : checks.length > 0 ? (
          <ol className="placement-history">
            {checks.slice(0, 8).map((check) => (
              <li
                className={`placement-history-${healthToneForResult(check.result)}`}
                key={check.id}
              >
                <span className="placement-history-icon">
                  <HealthIcon status={healthToneForResult(check.result)} />
                </span>
                <time dateTime={check.checkedAt}>{formatTime(check.checkedAt)}</time>
                <div>
                  <strong>{checkResultLabel(check.result)}</strong>
                  <small>{check.errorCode ?? checkSuccessDetail(check)}</small>
                  <em>{check.source === "manual" ? "Ручная" : "Плановая"}</em>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="placement-history-loading">Проверок ещё не было.</p>
        )}
      </DetailSection>
    </aside>
  );
}

function DetailSection({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`placement-detail-section ${className}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function HealthStatus({
  status,
  compact = false,
}: {
  status: PlacementHealthStatus;
  compact?: boolean;
}) {
  const tone = healthTone(status);
  return (
    <span
      className={`placement-health placement-health-${tone}${compact ? " placement-health-compact" : ""}`}
    >
      <HealthIcon status={tone} />
      {healthLabel(status)}
    </span>
  );
}

function HealthIcon({ status }: { status: "healthy" | "failed" | "degraded" | "unchecked" }) {
  const Icon =
    status === "healthy"
      ? CheckCircle2
      : status === "degraded"
        ? TriangleAlert
        : status === "failed"
          ? AlertCircle
          : CircleHelp;
  return <Icon size={16} strokeWidth={1.9} aria-hidden="true" />;
}

function healthTone(
  status: PlacementHealthStatus,
): "healthy" | "failed" | "degraded" | "unchecked" {
  if (status === "healthy") return "healthy";
  if (status === "degraded" || status === "awaiting_fix") return "degraded";
  if (status === "failed" || status === "exception") return "failed";
  return "unchecked";
}

function healthToneForResult(
  result: HealthCheckView["result"],
): "healthy" | "failed" | "degraded" | "unchecked" {
  if (result === "healthy") return "healthy";
  if (result === "failed") return "failed";
  if (result === "degraded") return "degraded";
  return "unchecked";
}

function healthLabel(status: PlacementHealthStatus) {
  const labels: Record<PlacementHealthStatus, string> = {
    unchecked: "Не проверено",
    healthy: "Работает",
    degraded: "Деградация",
    failed: "Ошибка",
    awaiting_fix: "Ожидает исправления",
    disabled: "Отключено",
    exception: "Исключение",
  };
  return labels[status];
}

function checkResultLabel(result: HealthCheckView["result"]) {
  const labels: Record<HealthCheckView["result"], string> = {
    healthy: "Работает",
    degraded: "Деградация",
    failed: "Ошибка",
    blocked: "Заблокировано",
    unknown: "Неизвестно",
  };
  return labels[result];
}

function checkSuccessDetail(check: HealthCheckView) {
  if (check.result === "healthy")
    return check.embedHttpStatus ? `HTTP ${check.embedHttpStatus}` : "OK";
  if (check.pageHttpStatus) return `HTTP ${check.pageHttpStatus}`;
  return "Нет дополнительных данных";
}

function checkNotice(placement: PlacementView, alertChange: "none" | "opened" | "closed") {
  if (alertChange === "opened")
    return `Проверка завершена: открыт технический Alert для ${placement.organizationName}.`;
  if (alertChange === "closed")
    return `Работоспособность ${placement.organizationName} восстановлена, Alert закрыт.`;
  return `L0-проверка ${placement.organizationName} завершена: ${healthLabel(placement.healthStatus)}.`;
}

function sortPlacements(placements: PlacementView[]) {
  return [...placements].sort(
    (left, right) =>
      left.organizationName.localeCompare(right.organizationName, "ru") ||
      left.id.localeCompare(right.id),
  );
}

function displayUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function formatMoment(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (dateFormat.format(date) === dateFormat.format(new Date())) {
    return `Сегодня, ${formatTime(value)}`;
  }
  return formatDateTime(value);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return formatDateOnly(value);
}

function embedTypeLabel(value: PlacementView["embedType"]) {
  return value === "video" ? "Видео" : value === "live" ? "Трансляция" : "Плейлист";
}

function businessStatusLabel(value: PlacementView["businessStatus"]) {
  const labels: Record<PlacementView["businessStatus"], string> = {
    planned: "Запланировано",
    active: "Активно",
    paused: "На паузе",
    ended: "Завершено",
  };
  return labels[value];
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isPlacementVersionConflict(error: unknown) {
  return error instanceof ApiError && error.problem.code === "PLACEMENT_VERSION_CONFLICT";
}
