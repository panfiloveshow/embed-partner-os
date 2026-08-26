import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Gauge,
  Mail,
  LoaderCircle,
  Phone,
  Rocket,
  Upload,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import {
  radarRejectReasonCodes,
  type CreateRadarCandidateCommand,
  type RadarCandidate,
  type RadarCandidateDecisionCommand,
  type RadarCandidateStatus,
  type RadarFeatureSignal,
  type RadarLprChannelLink,
  type RadarRejectReasonCode,
  type RadarScoreFactor,
} from "@embed-os/contracts";
import { closestLprChannel } from "@embed-os/domain";
import {
  ApiError,
  adjustRadarCandidateScore,
  createRadarCandidate,
  decideRadarCandidate,
  fetchRadar,
  fetchSenderProfile,
  inspectRadarCandidate,
  importRadarCandidates,
  saveSenderProfile,
} from "../lib/api";
import {
  inspectionPresentation,
  rejectReasonLabel,
  rejectReasonLabels,
  type RadarMessageTone,
} from "../lib/radar-presentation";
import { messageFor } from "../lib/problem";
import { createIdempotencyKey, mutationKey, type MutationKeyState } from "../lib/idempotency";
import { formatDate as formatDateOnly, formatDateTime } from "../lib/format";

interface RadarPageProps {
  teamName: string;
  onOpenToday: (opportunityId: string) => void;
}

const terminalStatuses = new Set<RadarCandidateStatus>(["accepted", "rejected", "merged"]);

/** Проверка выполняется асинхронно: очередь поллится каждые 3 секунды. */
const INSPECTION_POLL_INTERVAL_MS = 3_000;
/** Поллинг прекращается через ~2 минуты, даже если проверка не завершилась. */
const INSPECTION_POLL_TIMEOUT_MS = 120_000;

export function RadarPage({ teamName, onOpenToday }: RadarPageProps) {
  const [candidates, setCandidates] = useState<RadarCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<RadarCandidateStatus | "all">("all");
  const [formOpen, setFormOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: RadarMessageTone } | null>(null);
  const [trafficProviderConfigured, setTrafficProviderConfigured] = useState<boolean | null>(
    null,
  );
  const [trafficHintDismissed, setTrafficHintDismissed] = useState(false);
  const mutationKeys = useRef(new Map<string, string>());
  const createMutation = useRef<MutationKeyState | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchRadar(signal);
      setCandidates(payload.candidates);
      setTrafficProviderConfigured(
        payload.trafficProvider ? payload.trafficProvider.configured : null,
      );
      setSelectedId((current) =>
        current && payload.candidates.some(({ id }) => id === current)
          ? current
          : (payload.candidates[0]?.id ?? null),
      );
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

  const candidatesRef = useRef(candidates);
  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);

  const pendingIds = useMemo(
    () =>
      candidates
        .filter(({ inspectionPending }) => inspectionPending)
        .map(({ id }) => id)
        .sort()
        .join(","),
    [candidates],
  );

  useEffect(() => {
    if (!pendingIds) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > INSPECTION_POLL_TIMEOUT_MS) {
        window.clearInterval(timer);
        return;
      }
      void (async () => {
        try {
          const payload = await fetchRadar(controller.signal);
          for (const candidate of payload.candidates) {
            const wasPending = candidatesRef.current.find(
              ({ id }) => id === candidate.id,
            )?.inspectionPending;
            if (!wasPending || candidate.inspectionPending) continue;
            const evidence = candidate.evidence.at(-1);
            setNotice(
              evidence
                ? {
                    text: inspectionPresentation(evidence).notice,
                    tone: inspectionPresentation(evidence).noticeTone,
                  }
                : {
                    text: `Проверка «${candidate.name}» завершилась без результата. Повторите позже.`,
                    tone: "warning",
                  },
            );
          }
          setCandidates(payload.candidates);
        } catch {
          // Одна неудачная итерация поллинга не прерывает ожидание результата.
        }
      })();
    }, INSPECTION_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [pendingIds]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru-RU");
    return candidates.filter(
      (candidate) =>
        (status === "all" || candidate.status === status) &&
        (!needle ||
          `${candidate.name} ${candidate.hostNormalized} ${sourceLabel(candidate.source)}`
            .toLocaleLowerCase("ru-RU")
            .includes(needle)),
    );
  }, [candidates, query, status]);
  const selected = candidates.find(({ id }) => id === selectedId) ?? null;

  function updateCandidate(updated: RadarCandidate) {
    setCandidates((current) =>
      current.some(({ id }) => id === updated.id)
        ? current.map((candidate) => (candidate.id === updated.id ? updated : candidate))
        : [updated, ...current],
    );
    setSelectedId(updated.id);
  }

  async function create(command: CreateRadarCandidateCommand) {
    const key = mutationKey(createMutation, command, "radar-create");
    setBusyAction("create");
    setError(null);
    setNotice(null);
    try {
      const created = await createRadarCandidate(command, key);
      updateCandidate(created);
      createMutation.current = null;
      setFormOpen(false);
      setNotice({ text: `Кандидат «${created.name}» добавлен в очередь.`, tone: "success" });
      // Автоматическая первая проверка сайта: без неё кандидат бесполезен
      // до ручного клика «Проверить».
      if (!created.inspectionPending && created.status === "new") void inspect(created);
    } catch (createError) {
      setError(messageFor(createError));
    } finally {
      setBusyAction(null);
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setBusyAction("import");
    setError(null);
    setNotice(null);
    try {
      const result = await importRadarCandidates(file, createIdempotencyKey("radar-import"));
      await load();
      setNotice({
        text: `Импорт ${result.fileName}: добавлено ${result.created}, пропущено ${result.skipped}, ошибок ${result.failed}.`,
        tone: result.failed > 0 ? "warning" : "success",
      });
    } catch (importError) {
      setError(messageFor(importError));
    } finally {
      setBusyAction(null);
      if (importInput.current) importInput.current.value = "";
    }
  }

  async function inspect(candidate: RadarCandidate) {
    const scope = `check:${candidate.id}`;
    const key = mutationKeys.current.get(scope) ?? createIdempotencyKey("radar-check");
    mutationKeys.current.set(scope, key);
    setBusyAction(scope);
    setError(null);
    setNotice(null);
    try {
      const updated = await inspectRadarCandidate(candidate.id, key);
      updateCandidate(updated);
      mutationKeys.current.delete(scope);
      setNotice({
        text: "Проверка запущена и выполняется в фоне. Карточка обновится автоматически.",
        tone: "success",
      });
    } catch (inspectError) {
      setError(messageFor(inspectError));
    } finally {
      setBusyAction(null);
    }
  }

  async function decide(candidate: RadarCandidate, command: RadarCandidateDecisionCommand) {
    const hash = JSON.stringify(command);
    const scope = `decision:${candidate.id}:${hash}`;
    const key = mutationKeys.current.get(scope) ?? createIdempotencyKey("radar-decision");
    mutationKeys.current.set(scope, key);
    setBusyAction(`decision:${candidate.id}`);
    setError(null);
    setNotice(null);
    try {
      const updated = await decideRadarCandidate(candidate.id, command, key);
      updateCandidate(updated);
      mutationKeys.current.delete(scope);
      setNotice({ text: decisionNotice(updated), tone: "success" });
    } catch (decisionError) {
      if (
        decisionError instanceof ApiError &&
        decisionError.problem.code === "RADAR_CANDIDATE_VERSION_CONFLICT"
      ) {
        setNotice({ text: "Кандидат уже изменился. Очередь обновлена.", tone: "warning" });
        await load();
      } else {
        setError(messageFor(decisionError));
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function adjustScore(candidate: RadarCandidate, adjustment: number, comment: string) {
    const hash = JSON.stringify({ version: candidate.version, adjustment, comment });
    const scope = `score:${candidate.id}:${hash}`;
    const key = mutationKeys.current.get(scope) ?? createIdempotencyKey("radar-score");
    mutationKeys.current.set(scope, key);
    setBusyAction(`score:${candidate.id}`);
    setError(null);
    try {
      const updated = await adjustRadarCandidateScore(
        candidate.id,
        { version: candidate.version, adjustment, comment },
        key,
      );
      updateCandidate(updated);
      mutationKeys.current.delete(scope);
      setNotice({
        text: "Ручная корректировка score сохранена отдельно от расчёта.",
        tone: "success",
      });
    } catch (scoreError) {
      setError(messageFor(scoreError));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="main-area radar-main">
      <header className="page-header radar-page-header">
        <div>
          <h1>Радар</h1>
          <p>Поиск и квалификация новых партнёров</p>
        </div>
        <div className="header-actions">
          <label className="team-select">
            <UsersRound size={17} aria-hidden="true" />
            <span className="sr-only">Команда</span>
            <select value={teamName} disabled title="Мультикомандный режим появится позже">
              <option>{teamName}</option>
            </select>
          </label>
          <input
            ref={importInput}
            className="sr-only"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void importFile(event.target.files?.[0])}
            aria-label="Импорт кандидатов CSV или XLSX"
          />
          <button
            className="button button-secondary"
            type="button"
            onClick={() => importInput.current?.click()}
            disabled={busyAction === "import"}
          >
            {busyAction === "import" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Upload size={15} />
            )}
            Импорт CSV / XLSX
          </button>
          <button className="button button-primary" type="button" onClick={() => setFormOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            Добавить URL
          </button>
        </div>
      </header>

      {!loading && trafficProviderConfigured === false && !trafficHintDismissed ? (
        <Message tone="warning" onClose={() => setTrafficHintDismissed(true)}>
          Точный трафик не настроен: задайте SIMILARWEB_API_KEY (панельные
          данные) или включите бесплатный RADAR_TRANKO_ENABLED=1 (оценка по
          глобальному рангу Tranco). Остальные проверки Радара — контакты,
          тематика, плееры — работают и без трафика.
        </Message>
      ) : null}
      {error ? (
        <Message tone="error" onClose={() => setError(null)}>
          {error}
        </Message>
      ) : null}
      {notice ? (
        <Message tone={notice.tone} onClose={() => setNotice(null)}>
          {notice.text}
        </Message>
      ) : null}

      <SenderProfileCard />

      <section className="radar-workspace" aria-label="Очередь кандидатов">
        <div className="radar-queue-pane">
          {formOpen ? (
            <CandidateForm
              busy={busyAction === "create"}
              onSubmit={(command) => void create(command)}
              onClose={() => setFormOpen(false)}
            />
          ) : null}
          <div className="radar-queue-toolbar">
            <label className="radar-search">
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">Поиск кандидатов</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Поиск по сайту или домену"
              />
            </label>
            <label className="radar-status-filter">
              <span className="sr-only">Статус</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
              >
                <option value="all">Все статусы</option>
                <option value="new">Новые</option>
                <option value="ready">После проверки</option>
                <option value="deferred">Отложены</option>
                <option value="accepted">Приняты</option>
                <option value="rejected">Отклонены</option>
                <option value="merged">Объединены</option>
              </select>
              <ChevronDown size={13} aria-hidden="true" />
            </label>
          </div>

          {loading ? (
            <div className="radar-empty" aria-live="polite">
              <span className="loader" />
              <p>Загружаем кандидатов…</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="radar-empty">
              <Radar size={30} aria-hidden="true" />
              <strong>{candidates.length ? "Ничего не найдено" : "Очередь пуста"}</strong>
              <p>
                {candidates.length
                  ? "Измените поиск или фильтр."
                  : "Добавьте первую публичную страницу."}
              </p>
            </div>
          ) : (
            <ul className="radar-candidate-list" aria-label="Кандидаты">
              {visible.map((candidate) => {
                const latestEvidence = candidate.evidence.at(-1);
                const visualStatus =
                  candidate.status === "ready" && latestEvidence
                    ? `inspection-${inspectionPresentation(latestEvidence).tone}`
                    : candidate.status;
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      className={
                        candidate.id === selectedId
                          ? "radar-candidate-row radar-candidate-row-selected"
                          : "radar-candidate-row"
                      }
                      onClick={() => setSelectedId(candidate.id)}
                      aria-current={candidate.id === selectedId ? "true" : undefined}
                      aria-label={`Кандидат ${candidate.name}`}
                    >
                      <span
                        className={`radar-status-dot radar-status-dot-${visualStatus}`}
                        aria-hidden="true"
                      />
                      <span className="radar-candidate-identity">
                        <strong>{candidate.name}</strong>
                        <small>{candidate.hostNormalized}</small>
                      </span>
                      <span className={`radar-score radar-score-${candidate.score.priority}`}>
                        {candidate.score.total}
                      </span>
                      <span className="radar-candidate-source">
                        {sourceLabel(candidate.source)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selected ? (
          <CandidateDetail
            candidate={selected}
            candidates={candidates}
            busyAction={busyAction}
            onInspect={() => void inspect(selected)}
            onDecide={(command) => void decide(selected, command)}
            onAdjust={(adjustment, comment) => void adjustScore(selected, adjustment, comment)}
            onOpenToday={onOpenToday}
          />
        ) : (
          <div className="radar-detail-empty">
            <Gauge size={36} aria-hidden="true" />
            <strong>Выберите кандидата</strong>
            <p>Здесь появятся evidence, score и причины оценки.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function CandidateForm({
  busy,
  onSubmit,
  onClose,
}: {
  busy: boolean;
  onSubmit: (command: CreateRadarCandidateCommand) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("Ручной поиск");
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("");
  const [geography, setGeography] = useState("");
  const [frequency, setFrequency] =
    useState<CreateRadarCandidateCommand["publicationFrequency"]>("unknown");
  const [cms, setCms] = useState("");
  const [contactsFound, setContactsFound] = useState(false);
  const [videoMin, setVideoMin] = useState("");
  const [videoMax, setVideoMax] = useState("");
  const [trafficProvider, setTrafficProvider] = useState("");
  const [trafficMin, setTrafficMin] = useState("");
  const [trafficMax, setTrafficMax] = useState("");
  const [trafficDate, setTrafficDate] = useState("");
  const [trafficConfidence, setTrafficConfidence] = useState<"high" | "medium" | "low">("medium");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      name,
      url,
      source,
      ...(topic.trim() ? { topic: topic.trim() } : {}),
      ...(language.trim() ? { language: language.trim() } : {}),
      ...(geography.trim() ? { geography: geography.trim() } : {}),
      ...(frequency && frequency !== "unknown" ? { publicationFrequency: frequency } : {}),
      contactsFound,
      ...(cms.trim() ? { cms: cms.trim() } : {}),
      ...(videoMin ? { estimatedVideoPagesMin: Number(videoMin) } : {}),
      ...(videoMax ? { estimatedVideoPagesMax: Number(videoMax) } : {}),
      ...(trafficProvider.trim() && trafficMin && trafficMax && trafficDate
        ? {
            trafficEstimate: {
              provider: trafficProvider.trim(),
              measuredAt: new Date(`${trafficDate}T00:00:00`).toISOString(),
              minMonthlyVisits: Number(trafficMin),
              maxMonthlyVisits: Number(trafficMax),
              confidence: trafficConfidence,
            },
          }
        : {}),
    });
  }

  return (
    <form className="radar-add-form" onSubmit={submit}>
      <div className="radar-form-heading">
        <strong>Добавить кандидата</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Скрыть форму">
          <X size={15} />
        </button>
      </div>
      <label>
        <span>Название сайта</span>
        <input
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Например, Городской медиацентр"
        />
      </label>
      <label>
        <span>URL или домен</span>
        <input
          required
          type="text"
          inputMode="url"
          maxLength={2_000}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="example.ru/article"
        />
      </label>
      <label>
        <span>Источник</span>
        <select value={source} onChange={(event) => setSource(event.target.value)}>
          <option>Ручной поиск</option>
          <option>Рекомендация</option>
          <option>Публичный каталог</option>
        </select>
      </label>
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Добавить
      </button>
      <details className="radar-advanced-fields">
        <summary>Данные для Partner Score</summary>
        <div>
          <label>
            <span>Тематика</span>
            <input
              maxLength={200}
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Новости, спорт…"
            />
          </label>
          <label>
            <span>Язык</span>
            <input
              maxLength={40}
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              placeholder="ru"
            />
          </label>
          <label>
            <span>География</span>
            <input
              maxLength={120}
              value={geography}
              onChange={(event) => setGeography(event.target.value)}
              placeholder="Россия"
            />
          </label>
          <label>
            <span>Публикации</span>
            <select
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as typeof frequency)}
            >
              <option value="unknown">Неизвестно</option>
              <option value="daily">Ежедневно</option>
              <option value="weekly">Еженедельно</option>
              <option value="monthly">Ежемесячно</option>
            </select>
          </label>
          <label>
            <span>CMS / технология</span>
            <input
              maxLength={120}
              value={cms}
              onChange={(event) => setCms(event.target.value)}
              placeholder="WordPress"
            />
          </label>
          <label className="radar-checkbox">
            <input
              type="checkbox"
              checked={contactsFound}
              onChange={(event) => setContactsFound(event.target.checked)}
            />
            <span>Релевантный контакт найден</span>
          </label>
          <label>
            <span>Видеостраницы, от</span>
            <input
              type="number"
              min={0}
              step={1}
              value={videoMin}
              onChange={(event) => setVideoMin(event.target.value)}
            />
          </label>
          <label>
            <span>Видеостраницы, до</span>
            <input
              type="number"
              min={Number(videoMin) || 0}
              step={1}
              value={videoMax}
              onChange={(event) => setVideoMax(event.target.value)}
            />
          </label>
          <label>
            <span>Провайдер трафика</span>
            <input
              maxLength={120}
              value={trafficProvider}
              onChange={(event) => setTrafficProvider(event.target.value)}
              placeholder="Оценка аналитика"
            />
          </label>
          <label>
            <span>Визиты / мес., от</span>
            <input
              type="number"
              min={0}
              step={1}
              value={trafficMin}
              onChange={(event) => setTrafficMin(event.target.value)}
            />
          </label>
          <label>
            <span>Визиты / мес., до</span>
            <input
              type="number"
              min={Number(trafficMin) || 0}
              step={1}
              value={trafficMax}
              onChange={(event) => setTrafficMax(event.target.value)}
            />
          </label>
          <label>
            <span>Дата оценки</span>
            <input
              type="date"
              value={trafficDate}
              onChange={(event) => setTrafficDate(event.target.value)}
            />
          </label>
          <label>
            <span>Confidence трафика</span>
            <select
              value={trafficConfidence}
              onChange={(event) =>
                setTrafficConfidence(event.target.value as typeof trafficConfidence)
              }
            >
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </label>
        </div>
        <small>Трафик хранится как оценка: провайдер, дата, диапазон и confidence.</small>
      </details>
    </form>
  );
}

function CandidateDetail({
  candidate,
  candidates,
  busyAction,
  onInspect,
  onDecide,
  onAdjust,
  onOpenToday,
}: {
  candidate: RadarCandidate;
  candidates: RadarCandidate[];
  busyAction: string | null;
  onInspect: () => void;
  onDecide: (command: RadarCandidateDecisionCommand) => void;
  onAdjust: (adjustment: number, comment: string) => void;
  onOpenToday: (opportunityId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [rejectReasonCode, setRejectReasonCode] = useState<RadarRejectReasonCode | "">("");
  const [deferUntil, setDeferUntil] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [adjustment, setAdjustment] = useState(String(candidate.score.manualAdjustment));
  const [adjustmentComment, setAdjustmentComment] = useState(
    candidate.score.manualAdjustmentComment ?? "",
  );
  const latestEvidence = candidate.evidence.at(-1) ?? null;
  const latestPresentation = latestEvidence ? inspectionPresentation(latestEvidence) : null;
  const researchSignals = new Map(
    candidate.research?.signals.map((signal) => [signal.field, signal]) ?? [],
  );
  const researchProgress = new Set(candidate.research?.signals.map(({ field }) => field) ?? [])
    .size;
  const terminal = terminalStatuses.has(candidate.status);
  const busy = busyAction?.endsWith(candidate.id) ?? false;
  const lastDecision = candidate.decisions.at(-1) ?? null;
  const lastDecisionReasonLabel = rejectReasonLabel(lastDecision?.reasonCode ?? null);

  useEffect(() => {
    setReason("");
    setRejectReasonCode("");
    setDeferUntil("");
    setMergeTargetId("");
    setAdjustment(String(candidate.score.manualAdjustment));
    setAdjustmentComment(candidate.score.manualAdjustmentComment ?? "");
  }, [
    candidate.id,
    candidate.version,
    candidate.score.manualAdjustment,
    candidate.score.manualAdjustmentComment,
  ]);

  function command(decision: RadarCandidateDecisionCommand["decision"]) {
    if (!reason.trim()) return;
    onDecide({
      version: candidate.version,
      decision,
      reason: reason.trim(),
      ...(decision === "reject" && rejectReasonCode ? { reasonCode: rejectReasonCode } : {}),
      ...(decision === "defer" && deferUntil
        ? { deferUntil: new Date(deferUntil).toISOString() }
        : {}),
      ...(decision === "merge" && mergeTargetId ? { mergeTargetId } : {}),
    });
  }

  function startWork() {
    if (!candidate.research) return;
    const brief = candidate.research.brief;
    onDecide({
      version: candidate.version,
      decision: "accept",
      reason:
        `Квалифицировано по публичным данным. ${brief.siteSummary} Кейс: ${brief.rutubeUseCase}`.slice(
          0,
          1_000,
        ),
      comment: `Следующее действие: ${brief.nextAction}`.slice(0, 1_000),
    });
  }

  const groups = groupFactors(candidate.score.factors);
  return (
    <article className="radar-detail">
      <div className="radar-detail-header">
        <div>
          <h2>{candidate.name}</h2>
          <a href={candidate.pageUrl} target="_blank" rel="noreferrer">
            {candidate.hostNormalized}
            <ExternalLink size={13} />
          </a>
        </div>
        <RadarStatus candidate={candidate} />
      </div>

      <div className="radar-score-summary">
        <div>
          <strong>{candidate.score.total}</strong>
          <span>из 100</span>
        </div>
        <dl>
          <div>
            <dt>Приоритет</dt>
            <dd className={`radar-priority-${candidate.score.priority}`}>
              {priorityLabel(candidate.score.priority)}
            </dd>
          </div>
          <div>
            <dt>Авторасчёт</dt>
            <dd>{candidate.score.automaticTotal}</dd>
          </div>
          <div>
            <dt>Корректировка</dt>
            <dd>{signed(candidate.score.manualAdjustment)}</dd>
          </div>
        </dl>
      </div>

      <div
        className={`radar-evidence radar-evidence-${
          latestEvidence?.status === "not_found" && latestEvidence.detectedPlayers?.length
            ? "found"
            : (latestEvidence?.status ?? "empty")
        }`}
      >
        {latestEvidence?.playerFound || latestEvidence?.detectedPlayers?.length ? (
          <ShieldCheck size={19} />
        ) : (
          <AlertTriangle size={19} />
        )}
        <div>
          <strong>{evidenceLabel(latestEvidence)}</strong>
          <span>
            {candidate.inspectionPending
              ? "Проверка выполняется в фоне — карточка обновится автоматически"
              : latestEvidence
                ? `Метод ${latestEvidence.method} · confidence ${latestEvidence.confidence} · ${latestPresentation?.detail}`
                : "Запустите L0-проверку публичной страницы"}
          </span>
          {latestEvidence?.detectedPlayers?.length ? (
            <ul className="radar-player-chips" aria-label="Обнаруженные видеоплееры">
              {latestEvidence.detectedPlayers.map((player) => (
                <li
                  key={`${player.vendor}:${player.via}`}
                  className={
                    player.competitor
                      ? "radar-player-chip radar-player-chip-competitor"
                      : "radar-player-chip"
                  }
                  title={player.sampleUrl ?? undefined}
                >
                  <b>{player.label}</b>
                  <span>{player.via === "rendered" ? "рендер" : "статика"}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {latestEvidence ? <time>{formatDateTime(latestEvidence.detectedAt)}</time> : null}
        {!terminal ? (
          <button
            className="button button-secondary"
            type="button"
            onClick={onInspect}
            disabled={busyAction === `check:${candidate.id}` || candidate.inspectionPending}
          >
            <RefreshCw
              className={
                busyAction === `check:${candidate.id}` || candidate.inspectionPending ? "spin" : ""
              }
              size={14}
            />
            {candidate.inspectionPending
              ? "Проверяется…"
              : latestEvidence
                ? "Повторить"
                : "Проверить"}
          </button>
        ) : null}
      </div>

      {candidate.duplicateOrganization || candidate.duplicateCandidate ? (
        <div className="radar-duplicate" role="status">
          <AlertTriangle size={16} />
          <span>
            {candidate.duplicateOrganization
              ? `Домен уже у партнёра «${candidate.duplicateOrganization.name}».`
              : `Найден дубль кандидата «${candidate.duplicateCandidate?.name}».`}
          </span>
        </div>
      ) : null}

      {candidate.research ? (
        <div className="radar-research-summary" role="status">
          <div>
            <strong>Автоматически собрано {researchProgress} из 7 признаков</strong>
            <span>
              {candidate.research.method === "site-intelligence-v2"
                ? "Карта сайта + RSS + HTML"
                : "HTML-сигналы"}{" "}
              · {formatDateTime(candidate.research.collectedAt)}
            </span>
          </div>
          <div
            className="radar-research-progress"
            aria-label={`Собрано ${researchProgress} из 7 признаков`}
          >
            <span style={{ width: `${(researchProgress / 7) * 100}%` }} />
          </div>
          <small>
            Ручные данные менеджера не перезаписываются. Трафик добавляется только из внешнего
            источника с датой и confidence.
          </small>
        </div>
      ) : null}

      {candidate.research ? (
        <WorkBrief
          research={candidate.research}
          terminal={terminal}
          canStart={candidate.evidence.length > 0 && !candidate.duplicateOrganization}
          busy={busy}
          onStart={startWork}
        />
      ) : null}

      <section className="radar-detail-section">
        <h3>Характеристики сайта</h3>
        <dl className="radar-feature-grid">
          <Feature
            label="Тематика"
            value={candidate.features.topic}
            signal={researchSignals.get("topic")}
          />
          <Feature
            label="Язык"
            value={candidate.features.language}
            signal={researchSignals.get("language")}
          />
          <Feature
            label="География"
            value={candidate.features.geography}
            signal={researchSignals.get("geography")}
          />
          <Feature
            label="Публикации"
            value={frequencyLabel(candidate.features.publicationFrequency)}
            signal={researchSignals.get("publicationFrequency")}
          />
          <Feature
            label="CMS / технология"
            value={candidate.features.cms}
            signal={researchSignals.get("cms")}
          />
          <Feature
            label="Страницы с видео"
            value={rangeLabel(candidate)}
            signal={researchSignals.get("estimatedVideoPages")}
          />
          <Feature
            label="Контакт"
            value={candidate.features.contactsFound ? "Найден" : "Не найден"}
            signal={researchSignals.get("contactsFound")}
          />
          <Feature
            label="Посещаемость"
            value={trafficLabel(candidate)}
            hint={trafficHint(candidate)}
          />
        </dl>
      </section>

      <section className="radar-detail-section">
        <div className="radar-section-heading">
          <h3>Факторы оценки</h3>
          <span>{candidate.score.modelVersion}</span>
        </div>
        <div className="radar-factor-groups">
          {groups.map(({ key, label, factors }) => (
            <div key={key} className={`radar-factor-group radar-factor-group-${key}`}>
              <strong>
                {label}
                <span>{factorTotal(factors)}</span>
              </strong>
              {factors.map((factor) => (
                <div key={factor.code} title={factor.explanation}>
                  <span>{factor.label}</span>
                  <b>
                    {signed(factor.value)} / {Math.abs(factor.maxValue)}
                  </b>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {!terminal ? (
        <section className="radar-operator-panel">
          <label className="radar-reason">
            <span>Причина решения</span>
            <textarea
              required
              maxLength={1_000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Кратко зафиксируйте обоснование"
            />
          </label>
          <div className="radar-decision-options">
            <label>
              <span>Пересмотреть</span>
              <input
                type="datetime-local"
                value={deferUntil}
                onChange={(event) => setDeferUntil(event.target.value)}
              />
            </label>
            <label>
              <span>Объединить с</span>
              <select
                value={mergeTargetId}
                onChange={(event) => setMergeTargetId(event.target.value)}
              >
                <option value="">Выберите кандидата</option>
                {candidates
                  .filter(({ id, status }) => id !== candidate.id && status !== "merged")
                  .map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>Причина отказа</span>
              <select
                value={rejectReasonCode}
                onChange={(event) =>
                  setRejectReasonCode(event.target.value as RadarRejectReasonCode | "")
                }
              >
                <option value="">Выберите причину</option>
                {radarRejectReasonCodes.map((code) => (
                  <option key={code} value={code}>
                    {rejectReasonLabels[code]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="radar-decision-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={
                busy ||
                !reason.trim() ||
                candidate.evidence.length === 0 ||
                Boolean(candidate.duplicateOrganization)
              }
              onClick={() => command("accept")}
            >
              <Check size={15} />
              Принять
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || !reason.trim() || !deferUntil}
              onClick={() => command("defer")}
            >
              Отложить
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || !reason.trim() || !mergeTargetId}
              onClick={() => command("merge")}
            >
              Объединить
            </button>
            <button
              className="button button-danger-outline"
              type="button"
              disabled={busy || !reason.trim() || !rejectReasonCode}
              onClick={() => command("reject")}
            >
              Отклонить
            </button>
          </div>
          <form
            className="radar-score-adjustment"
            onSubmit={(event) => {
              event.preventDefault();
              onAdjust(Number(adjustment), adjustmentComment.trim());
            }}
          >
            <label>
              <span>Ручная поправка</span>
              <input
                required
                type="number"
                min={-40}
                max={40}
                step={1}
                value={adjustment}
                onChange={(event) => setAdjustment(event.target.value)}
              />
            </label>
            <label>
              <span>Комментарий</span>
              <input
                required
                maxLength={1_000}
                value={adjustmentComment}
                onChange={(event) => setAdjustmentComment(event.target.value)}
                placeholder="Обязателен для ручной поправки"
              />
            </label>
            <button
              className="button button-secondary"
              type="submit"
              disabled={busyAction === `score:${candidate.id}` || !adjustmentComment.trim()}
            >
              Сохранить score
            </button>
          </form>
        </section>
      ) : (
        <div className="radar-terminal-summary">
          <Check size={16} />
          <span>{decisionNotice(candidate)}</span>
          {lastDecision ? (
            <small>
              {lastDecisionReasonLabel
                ? `${lastDecisionReasonLabel} — ${lastDecision.reason}`
                : lastDecision.reason}
            </small>
          ) : null}
          {candidate.status === "accepted" && candidate.acceptedOpportunityId ? (
            <button
              className="button button-primary"
              type="button"
              onClick={() => onOpenToday(candidate.acceptedOpportunityId!)}
            >
              Открыть первую задачу
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}

function WorkBrief({
  research,
  terminal,
  canStart,
  busy,
  onStart,
}: {
  research: NonNullable<RadarCandidate["research"]>;
  terminal: boolean;
  canStart: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  const { brief } = research;
  const [copied, setCopied] = useState(false);
  const potential = brief.opportunityPotential;
  const outreach = brief.outreach;
  const readiness = {
    ready_for_outreach: "Готово к первичному контакту",
    contact_page_found: "Найдена точка входа",
    needs_contact: "Нужен поиск контакта",
  }[brief.readiness];
  return (
    <section className="radar-work-brief" aria-labelledby="radar-work-brief-title">
      <div className="radar-work-brief-heading">
        <div>
          <span>{readiness}</span>
          <h3 id="radar-work-brief-title">Рабочее досье</h3>
        </div>
        {!terminal ? (
          <button
            className="button button-primary"
            type="button"
            disabled={!canStart || busy}
            onClick={onStart}
          >
            <Rocket size={15} />
            Начать работу
          </button>
        ) : null}
      </div>
      <p className="radar-work-summary">{brief.siteSummary}</p>
      {research.changeSignals?.length ? (
        <div className="radar-change-signals" role="status">
          <strong>Изменения с прошлого сканирования</strong>
          <ul>
            {research.changeSignals.map((signal) => (
              <li key={`${signal.code}:${signal.detectedAt}`}>
                <b>{signal.label}</b>
                <span>{signal.explanation}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {brief.whyNow ? (
        <div className="radar-why-now">
          <div>
            <Gauge size={15} />
            <strong>Почему стоит начать сейчас</strong>
          </div>
          <p>{brief.whyNow}</p>
          {brief.priorityInsights?.length ? (
            <ul>
              {brief.priorityInsights.map((insight) => (
                <li key={insight.code}>
                  <b>{insight.label}</b>
                  <span>{insight.explanation}</span>
                  <small>{confidenceLabel(insight.confidence)}</small>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {potential || research.coverage ? (
        <div className="radar-potential-grid">
          <div>
            <span>Посещений в день</span>
            <strong>
              {potential?.minDailyVisits !== null &&
              potential?.minDailyVisits !== undefined &&
              potential.maxDailyVisits !== null
                ? `${formatCompactNumber(potential.minDailyVisits)}–${formatCompactNumber(potential.maxDailyVisits)}`
                : "Нет провайдера"}
            </strong>
          </div>
          <div>
            <span>Доля видео в выборке</span>
            <strong>
              {potential?.observedVideoSharePercent !== null &&
              potential?.observedVideoSharePercent !== undefined
                ? `${potential.observedVideoSharePercent}%`
                : "—"}
            </strong>
          </div>
          <div>
            <span>Видео-возможностей / мес.</span>
            <strong>
              {potential?.minMonthlyVideoOpportunities !== null &&
              potential?.minMonthlyVideoOpportunities !== undefined &&
              potential.maxMonthlyVideoOpportunities !== null
                ? `${formatCompactNumber(potential.minMonthlyVideoOpportunities)}–${formatCompactNumber(potential.maxMonthlyVideoOpportunities)}`
                : "Нужен трафик"}
            </strong>
          </div>
          <div>
            <span>Покрытие исследования</span>
            <strong>
              {research.coverage
                ? `${research.coverage.coveragePercent}% · ${research.coverage.inspectedUrls}/${research.coverage.discoveredUrls}`
                : "Базовое"}
            </strong>
          </div>
          {potential ? (
            <small>
              {potential.basis} · {confidenceLabel(potential.confidence)}
            </small>
          ) : null}
        </div>
      ) : null}
      <div className="radar-work-grid">
        <div>
          <strong>Где видео</strong>
          <p>{brief.videoUsage}</p>
        </div>
        <div>
          <strong>Кейс RUTUBE</strong>
          <p>{brief.rutubeUseCase}</p>
        </div>
        <div>
          <strong>Кого искать</strong>
          <p>{brief.likelyContactRoles.join(" · ")}</p>
        </div>
        <div>
          <strong>Следующий шаг</strong>
          <p>{brief.nextAction}</p>
        </div>
      </div>
      {outreach ? (
        <div className="radar-outreach-package">
          <div className="radar-outreach-heading">
            <div>
              <Mail size={14} />
              <strong>Готовое первое касание</strong>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(`${outreach.subject}\n\n${outreach.messageDraft}`)
                  .then(() => setCopied(true));
              }}
            >
              <Copy size={13} />
              {copied ? "Скопировано" : "Скопировать"}
            </button>
          </div>
          <dl>
            <div>
              <dt>Адресат</dt>
              <dd>
                {outreach.targetName ? `${outreach.targetName} · ` : ""}
                {outreach.targetRole}
              </dd>
            </div>
            <div>
              <dt>Канал</dt>
              <dd>
                {outreachChannelLabel(outreach.channel)}
                {outreach.destination ? ` · ${outreach.destination}` : ""}
              </dd>
            </div>
          </dl>
          <label>
            Тема
            <input readOnly value={outreach.subject} />
          </label>
          <label>
            Черновик
            <textarea readOnly value={outreach.messageDraft} />
          </label>
          <div className="radar-discovery-questions">
            <strong>Вопросы для квалификации</strong>
            <ol>
              {outreach.discoveryQuestions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ol>
          </div>
          <p>
            <b>Задача:</b> {outreach.nextTask}
          </p>
        </div>
      ) : null}
      <div className="radar-decision-makers">
        <strong>
          <UsersRound size={14} /> ЛПР и целевые контакты
        </strong>
        {research.decisionMakers.length > 0 ? (
          <div className="radar-decision-maker-list">
            {research.decisionMakers.map((person, index) => (
              <article key={`${person.fullName}:${person.role}:${index}`}>
                <div>
                  <b>{person.fullName ?? "Имя не подтверждено"}</b>
                  <span>
                    {person.role}
                    {person.department ? ` · ${person.department}` : ""}
                  </span>
                </div>
                <div className="radar-decision-maker-channels">
                  {person.email ? (
                    <a href={`mailto:${person.email}`}>
                      <Mail size={12} />
                      {person.email}
                    </a>
                  ) : null}
                  {person.phone ? (
                    <a href={`tel:${person.phone}`}>
                      <Phone size={12} />
                      {person.phone}
                    </a>
                  ) : null}
                  {person.profileUrl ? (
                    <a href={person.profileUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={12} />
                      Профиль
                    </a>
                  ) : null}
                </div>
                {person.email || person.phone ? null : (() => {
                  const channel = closestLprChannel(person, research.contacts);
                  return channel ? (
                    <div className="radar-lpr-channel-link">
                      <b>Ближайший канал</b>{" "}
                      {channel.contactType === "email" ? (
                        <a href={`mailto:${channel.contactValue}`}>
                          <Mail size={12} />
                          {channel.contactValue}
                        </a>
                      ) : channel.contactType === "phone" ? (
                        <a href={`tel:${channel.contactValue}`}>
                          <Phone size={12} />
                          {channel.contactValue}
                        </a>
                      ) : channel.contactHref ? (
                        <a href={channel.contactHref} target="_blank" rel="noreferrer">
                          <ExternalLink size={12} />
                          {channel.contactValue}
                        </a>
                      ) : (
                        <span>{channel.contactValue}</span>
                      )}
                      <small>
                        {channel.rationale} · {confidenceLabel(channel.confidence)}
                      </small>
                    </div>
                  ) : null;
                })()}
                <small>
                  {confidenceLabel(person.confidence)} ·{" "}
                  <a href={person.sourceUrl} target="_blank" rel="noreferrer">
                    источник
                  </a>
                </small>
              </article>
            ))}
          </div>
        ) : (
          <p>
            ЛПР с подтверждёнными именем и должностью не найден. Ниже показаны общие публичные
            каналы, если они есть.
          </p>
        )}
        {research.decisionMakers.length > 0 ? (
          (() => {
            const person = research.decisionMakers[0];
            if (!person) return null;
            const direct: RadarLprChannelLink | null = person.email
              ? { contactType: "email", contactValue: person.email, contactHref: `mailto:${person.email}`, rationale: "Прямой email из публичных источников", confidence: "high" }
              : person.phone
                ? { contactType: "phone", contactValue: person.phone, contactHref: `tel:${person.phone}`, rationale: "Прямой телефон из публичных источников", confidence: "high" }
                : closestLprChannel(person, research.contacts);
            const chosenHref = direct?.contactHref ?? null;
            const alternatives = research.contacts
              .filter((contact) => contact.href !== chosenHref)
              .slice(0, 4);
            return (
              <div className="radar-lpr-path-map">
                <div className="radar-lpr-path-title">🗺️ Как выйти на ЛПР</div>
                <ol className="radar-lpr-path-steps">
                  <li>
                    <span className="radar-lpr-path-step-label">Цель</span>
                    <div>
                      <b>{person.fullName ?? "Имя не подтверждено"}</b>
                      <small>
                        {person.role}
                        {person.department ? ` · ${person.department}` : ""} ·{" "}
                        {confidenceLabel(person.confidence)}
                      </small>
                    </div>
                  </li>
                  <li>
                    <span className="radar-lpr-path-step-label">Канал входа</span>
                    <div>
                      {direct ? (
                        <>
                          {direct.contactType === "email" ? (
                            <a href={`mailto:${direct.contactValue}`}>
                              <Mail size={12} />
                              {direct.contactValue}
                            </a>
                          ) : direct.contactType === "phone" ? (
                            <a href={`tel:${direct.contactValue}`}>
                              <Phone size={12} />
                              {direct.contactValue}
                            </a>
                          ) : direct.contactHref ? (
                            <a href={direct.contactHref} target="_blank" rel="noreferrer">
                              <ExternalLink size={12} />
                              {direct.contactValue}
                            </a>
                          ) : (
                            <span>{direct.contactValue}</span>
                          )}
                          <small>
                            {direct.rationale} · {confidenceLabel(direct.confidence)}
                          </small>
                        </>
                      ) : (
                        <small>Публичных каналов не найдено — путь через руководителя площадки.</small>
                      )}
                    </div>
                  </li>
                  {alternatives.length > 0 ? (
                    <li>
                      <span className="radar-lpr-path-step-label">Запасные пути</span>
                      <div className="radar-lpr-path-alternatives">
                        {alternatives.map((contact) =>
                          contact.type === "email" ? (
                            <a key={`${contact.type}:${contact.href}`} href={`mailto:${contact.href.replace(/^mailto:/, "")}`}>
                              <Mail size={11} />
                              {contact.value}
                            </a>
                          ) : contact.type === "phone" ? (
                            <a key={`${contact.type}:${contact.href}`} href={`tel:${contact.href.replace(/^tel:/, "")}`}>
                              <Phone size={11} />
                              {contact.value}
                            </a>
                          ) : contact.type === "telegram" ? (
                            <a key={`${contact.type}:${contact.href}`} href={contact.href} target="_blank" rel="noreferrer">
                              <Send size={11} />
                              {contact.value}
                            </a>
                          ) : (
                            <a key={`${contact.type}:${contact.href}`} href={contact.href} target="_blank" rel="noreferrer">
                              <ExternalLink size={11} />
                              {contact.value}
                            </a>
                          ),
                        )}
                      </div>
                      <small>Если основной канал молчит — обходные точки входа.</small>
                    </li>
                  ) : null}
                  <li>
                    <span className="radar-lpr-path-step-label">Письмо</span>
                    <div>
                      <small>
                        Готовое первое касание под ЛПР — в блоке «Готовое первое касание» ниже;
                        перед отправкой сверьте адресата с картой.
                      </small>
                    </div>
                  </li>
                </ol>
              </div>
            );
          })()
        ) : null}
      </div>
      <div className="radar-lead-columns">
        <div>
          <strong>Каналы связи</strong>
          {research.contacts.length > 0 ? (
            <ul>
              {research.contacts.map((contact) => (
                <li key={`${contact.type}:${contact.href}`}>
                  {contact.type === "email" ? (
                    <Mail size={13} />
                  ) : contact.type === "phone" ? (
                    <Phone size={13} />
                  ) : contact.type === "telegram" ? (
                    <Send size={13} />
                  ) : (
                    <ExternalLink size={13} />
                  )}
                  <a
                    href={contact.href}
                    target={
                      contact.type === "contact_page" || contact.type === "telegram"
                        ? "_blank"
                        : undefined
                    }
                    rel={
                      contact.type === "contact_page" || contact.type === "telegram"
                        ? "noreferrer"
                        : undefined
                    }
                  >
                    {contact.value}
                  </a>
                  {contact.type === "telegram" && contact.kind ? (
                    <small>
                      {contact.kind === "author" ? "канал автора" : "канал площадки"} ·{" "}
                      {confidenceLabel(contact.confidence)}
                    </small>
                  ) : (
                    <small>{confidenceLabel(contact.confidence)}</small>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>Прямой канал не найден — задача будет создана на поиск контакта.</p>
          )}
        </div>
        <div>
          <strong>Примеры видеостраниц</strong>
          {research.videoPages.length > 0 ? (
            <ul>
              {research.videoPages.map((page) => (
                <li key={page.pageUrl}>
                  <ExternalLink size={13} />
                  <a href={page.pageUrl} target="_blank" rel="noreferrer">
                    {page.label}
                  </a>
                  <small>{confidenceLabel(page.confidence)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>Подтверждённых примеров пока нет.</p>
          )}
        </div>
      </div>
      <div className="radar-work-risks">
        <strong>Что проверить</strong>
        <ul>
          {brief.risks.map((risk) => (
            <li key={risk}>{risk}</li>
          ))}
        </ul>
      </div>
      {!terminal ? (
        <small className="radar-work-confirmation">
          «Начать работу» создаст внутренние организацию, возможность, контакт и первую задачу.
          Никаких сообщений наружу система не отправляет.
        </small>
      ) : null}
    </section>
  );
}

function Message({
  tone,
  onClose,
  children,
}: {
  tone: RadarMessageTone;
  onClose: () => void;
  children: string;
}) {
  return (
    <div
      className={`radar-message radar-message-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {tone === "success" ? <Check size={16} /> : <AlertTriangle size={16} />}
      <span>{children}</span>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Скрыть сообщение">
        <X size={14} />
      </button>
    </div>
  );
}

function RadarStatus({ candidate }: { candidate: RadarCandidate }) {
  const evidence = candidate.evidence.at(-1);
  if (candidate.status === "ready" && evidence) {
    const presentation = inspectionPresentation(evidence);
    return (
      <span className={`radar-status radar-status-inspection-${presentation.tone}`}>
        {presentation.statusLabel}
      </span>
    );
  }
  return (
    <span className={`radar-status radar-status-${candidate.status}`}>
      {statusLabel(candidate.status)}
    </span>
  );
}

function Feature({
  label,
  value,
  signal,
  hint,
}: {
  label: string;
  value: string | null;
  signal?: RadarFeatureSignal;
  hint?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span>{value || "—"}</span>
        {signal ? (
          <small>
            {signal.source} · {confidenceLabel(signal.confidence)}
          </small>
        ) : hint ? (
          <small>{hint}</small>
        ) : null}
      </dd>
    </div>
  );
}

function groupFactors(factors: RadarScoreFactor[]) {
  const labels: Record<RadarScoreFactor["group"], string> = {
    business: "Бизнес",
    content: "Контент",
    technical: "Техника",
    contact: "Контактность",
    risk: "Риски",
  };
  return (Object.keys(labels) as RadarScoreFactor["group"][])
    .map((key) => ({
      key,
      label: labels[key],
      factors: factors.filter(({ group }) => group === key),
    }))
    .filter(({ factors }) => factors.length > 0);
}

function factorTotal(factors: RadarScoreFactor[]) {
  const value = factors.reduce((sum, factor) => sum + factor.value, 0);
  const max = factors.reduce((sum, factor) => sum + Math.abs(factor.maxValue), 0);
  return `${signed(value)} / ${max}`;
}

function statusLabel(status: RadarCandidateStatus) {
  return {
    new: "Новый",
    ready: "После проверки",
    deferred: "Отложен",
    rejected: "Отклонён",
    accepted: "Принят",
    merged: "Объединён",
  }[status];
}

function priorityLabel(priority: RadarCandidate["score"]["priority"]) {
  return { high: "Высокий", medium: "Средний", low: "Низкий" }[priority];
}

/** Candidates found by the sourcing worker carry the technical source "auto". */
function sourceLabel(source: RadarCandidate["source"]) {
  return source === "auto" ? "Автопоиск" : source;
}

function frequencyLabel(value: RadarCandidate["features"]["publicationFrequency"]) {
  return {
    daily: "Ежедневно",
    weekly: "Еженедельно",
    monthly: "Ежемесячно",
    unknown: "Не определено",
  }[value];
}

function confidenceLabel(value: RadarFeatureSignal["confidence"]) {
  return { high: "высокая уверенность", medium: "средняя уверенность", low: "низкая уверенность" }[
    value
  ];
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function outreachChannelLabel(
  value: NonNullable<NonNullable<RadarCandidate["research"]>["brief"]["outreach"]>["channel"],
) {
  return {
    email: "Email",
    phone: "Телефон",
    profile: "Профиль",
    contact_page: "Форма связи",
    telegram: "Telegram",
    research: "Нужен поиск",
  }[value];
}

function evidenceLabel(evidence: RadarCandidate["evidence"][number] | null) {
  if (!evidence) return "Evidence ещё не собрано";
  const competitors = (evidence.detectedPlayers ?? [])
    .filter(({ competitor }) => competitor)
    .map(({ label }) => label);
  if (evidence.status === "found") {
    return competitors.length > 0
      ? `Сайт уже встраивает ${competitors.join(", ")}`
      : `Плеер ${evidence.playerType ?? "video"} обнаружен`;
  }
  if (evidence.status === "not_found") {
    return evidence.detectedPlayers?.length
      ? `Найден видеоплеер: ${evidence.detectedPlayers.map(({ label }) => label).join(", ")}`
      : "Сигнатуры видео не найдены";
  }
  if (evidence.status === "blocked") return "Проверка ограничена правилами сайта";
  return "Результат проверки неопределён";
}

function rangeLabel(candidate: RadarCandidate) {
  const { estimatedVideoPagesMin: min, estimatedVideoPagesMax: max } = candidate.features;
  return min === null && max === null ? null : `${min ?? 0}–${max ?? min ?? 0}`;
}

function trafficLabel(candidate: RadarCandidate) {
  const traffic = candidate.features.trafficEstimate;
  if (!traffic) return null;
  if (traffic.minDailyVisits !== undefined && traffic.maxDailyVisits !== undefined) {
    return `${traffic.minDailyVisits.toLocaleString("ru-RU")}–${traffic.maxDailyVisits.toLocaleString("ru-RU")} посещений / день`;
  }
  return `${traffic.minMonthlyVisits.toLocaleString("ru-RU")}–${traffic.maxMonthlyVisits.toLocaleString("ru-RU")} / мес.`;
}

function trafficHint(candidate: RadarCandidate) {
  const traffic = candidate.features.trafficEstimate;
  if (!traffic) return "Similarweb не подключён — цифры не подменяются предположением";
  const period =
    traffic.periodStart && traffic.periodEnd
      ? ` · период ${formatDateOnly(traffic.periodStart)}–${formatDateOnly(traffic.periodEnd)}`
      : "";
  return `${traffic.provider} · ${traffic.minMonthlyVisits.toLocaleString("ru-RU")}–${traffic.maxMonthlyVisits.toLocaleString("ru-RU")} / мес. · confidence ${traffic.confidence}${period}`;
}

function decisionNotice(candidate: RadarCandidate) {
  if (candidate.status === "accepted")
    return "Кандидат принят: созданы организация, возможность и первая задача.";
  if (candidate.status === "deferred")
    return `Кандидат отложен до ${candidate.deferUntil ? formatDateTime(candidate.deferUntil) : "новой даты"}.`;
  if (candidate.status === "rejected") return "Кандидат отклонён с сохранением причины.";
  if (candidate.status === "merged") return "Кандидат объединён с канонической записью.";
  return "Решение сохранено.";
}

/**
 * Профиль отправителя первого касания: менеджер заполняет свои данные,
 * и они подставляются подписью в черновики писем всех досье Радара.
 */
function SenderProfileCard() {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [telegram, setTelegram] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchSenderProfile()
      .then((profile) => {
        if (cancelled) return;
        setFullName(profile.fullName ?? "");
        setEmail(profile.email ?? "");
        setTelegram(profile.telegram ?? "");
      })
      .catch(() => {
        if (!cancelled) setError("Не удалось загрузить профиль отправителя");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await saveSenderProfile({
        fullName: fullName.trim() || null,
        email: email.trim() || null,
        telegram: telegram.trim().replace(/^@/, "") || null,
      });
      setSaved(true);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.message
          ? cause.message
          : "Не удалось сохранить профиль",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="radar-sender-profile" aria-label="Подпись для писем">
      <button type="button" className="radar-sender-toggle" onClick={() => setOpen(!open)}>
        <UsersRound size={15} aria-hidden="true" />
        Подпись для писем {saved ? "(сохранено)" : ""}
        <ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open ? (
        <form className="radar-add-form" onSubmit={(event) => void submit(event)}>
          <p className="radar-hint">
            Ваши имя и контакты будут подписью в черновиках первых писем. Данные хранятся
            в вашей учётной записи.
          </p>
          <label>
            Имя и фамилия
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Анна Соколова"
              maxLength={120}
            />
          </label>
          <label>
            Email
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="a.sokolova@rutube.ru"
              type="email"
              maxLength={254}
            />
          </label>
          <label>
            Telegram (без @)
            <input
              value={telegram}
              onChange={(event) => setTelegram(event.target.value)}
              placeholder="asokolova"
              maxLength={64}
            />
          </label>
          {error ? (
            <span role="alert" className="radar-error-text">
              {error}
            </span>
          ) : null}
          <button type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
            Сохранить подпись
          </button>
        </form>
      ) : null}
    </section>
  );
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}
