import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, Send, UsersRound } from "lucide-react";
import type {
  CompleteTaskCommand,
  ContactCandidate,
  ContactOption,
  CreateContactCommand,
  LinkContactCommand,
  MergeContactCommand,
  TodayAction,
  TodayPayload,
  TransitionOpportunityStageCommand,
  RescheduleTaskCommand,
  SessionPayload,
} from "@embed-os/contracts";
import {
  ApiError,
  completeTask,
  createContact,
  fetchToday,
  fetchSession,
  linkContact,
  mergeContact,
  transitionOpportunityStage,
  rescheduleTask,
} from "./lib/api";
import { messageFor } from "./lib/problem";
import { createIdempotencyKey, mutationKey, type MutationKeyState } from "./lib/idempotency";
import { longDateFormat } from "./lib/format";
import { applyContactMerge, collectMergeTargets } from "./lib/contact-merge";
import { pageFromHash } from "./lib/routing";
import { Sidebar } from "./components/Sidebar";
import type { AppPage } from "./components/Sidebar";
import { SummaryStrip } from "./components/SummaryStrip";
import { TaskGroups } from "./components/TaskGroups";
import { DetailPanel } from "./components/DetailPanel";
import { CompletionDialog } from "./components/CompletionDialog";
import { AddContactDialog } from "./components/AddContactDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WeeklyReportPage } from "./components/WeeklyReportPage";
import { PlacementPage } from "./components/PlacementPage";
import { FunnelPage } from "./components/FunnelPage";
import { PartnersPage } from "./components/PartnersPage";
import { RadarPage } from "./components/RadarPage";
import { SettingsPage } from "./components/SettingsPage";
import { StageTransitionDialog } from "./components/StageTransitionDialog";
import { RescheduleTaskDialog } from "./components/RescheduleTaskDialog";
import { MergeContactDialog } from "./components/MergeContactDialog";

interface AppProps {
  onLogout?: () => Promise<void>;
}

function pageFromLocation(): AppPage {
  return pageFromHash(window.location.hash);
}

export function App({ onLogout }: AppProps) {
  const [activePage, setActivePage] = useState<AppPage>(pageFromLocation);
  const [payload, setPayload] = useState<TodayPayload | null>(null);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completingTask, setCompletingTask] = useState<TodayAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [contactTask, setContactTask] = useState<TodayAction | null>(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactCandidates, setContactCandidates] = useState<ContactCandidate[]>([]);
  const completionMutation = useRef<MutationKeyState | null>(null);
  const contactMutation = useRef<MutationKeyState | null>(null);
  const contactLinkMutation = useRef<MutationKeyState | null>(null);
  const [mergeSource, setMergeSource] = useState<{
    task: TodayAction;
    contact: ContactOption;
  } | null>(null);
  const [mergeKey, setMergeKey] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  const mergeReturnFocus = useRef<HTMLElement | null>(null);
  const mergeNoticeRef = useRef<HTMLDivElement>(null);
  const [stageTask, setStageTask] = useState<TodayAction | null>(null);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const stageMutation = useRef<MutationKeyState | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<TodayAction | null>(null);
  const [rescheduleBusy, setRescheduleBusy] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const rescheduleMutation = useRef<MutationKeyState | null>(null);

  const navigate = useCallback((page: AppPage) => {
    setActivePage(page);
    const hash = `#/${page}`;
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  useEffect(() => {
    const onHashChange = () => setActivePage(pageFromLocation());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [nextSession, nextPayload] = await Promise.all([
        fetchSession(signal),
        fetchToday(signal),
      ]);
      setSession(nextSession);
      setPayload(nextPayload);
      setSelectedId((current) => current ?? nextPayload.actions[0]?.id ?? null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(messageFor(loadError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  async function openRadarWork(opportunityId: string) {
    setError(null);
    try {
      const nextPayload = await fetchToday();
      setPayload(nextPayload);
      setSelectedId(
        nextPayload.actions.find((action) => action.opportunityId === opportunityId)?.id ??
          nextPayload.actions[0]?.id ??
          null,
      );
      navigate("today");
    } catch (loadError) {
      setError(messageFor(loadError));
      navigate("today");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const selectedTask = useMemo(
    () => payload?.actions.find((action) => action.id === selectedId) ?? null,
    [payload, selectedId],
  );
  const mergeTargets = useMemo(
    () => (payload && mergeSource ? collectMergeTargets(payload, mergeSource.contact.id) : []),
    [payload, mergeSource],
  );
  const placementContexts = useMemo(() => {
    if (!payload) return [];
    const contexts = new Map<
      string,
      {
        organizationId: string;
        opportunityId: string;
        organizationName: string;
      }
    >();
    for (const action of payload.actions) {
      if (!contexts.has(action.opportunityId)) {
        contexts.set(action.opportunityId, {
          organizationId: action.organizationId,
          opportunityId: action.opportunityId,
          organizationName: action.organizationName,
        });
      }
    }
    return [...contexts.values()].sort((left, right) =>
      left.organizationName.localeCompare(right.organizationName, "ru"),
    );
  }, [payload]);

  async function submitCompletion(command: CompleteTaskCommand) {
    if (!completingTask) return;
    const key = mutationKey(completionMutation, command, `task-complete:${completingTask.id}`);
    setBusy(true);
    setFormError(null);
    try {
      const nextPayload = await completeTask(completingTask.id, command, key);
      setPayload(nextPayload);
      setCompletingTask(null);
      completionMutation.current = null;
      setSelectedId(nextPayload.actions[0]?.id ?? null);
    } catch (submitError) {
      setFormError(messageFor(submitError));
    } finally {
      setBusy(false);
    }
  }

  function openCompletion(task: TodayAction) {
    setCompletingTask(task);
    completionMutation.current = null;
    setFormError(null);
  }

  function cancelCompletion() {
    setCompletingTask(null);
    completionMutation.current = null;
    setFormError(null);
  }

  async function submitContact(command: CreateContactCommand) {
    if (!contactTask) return;
    const key = mutationKey(
      contactMutation,
      command,
      `contact-create:${contactTask.organizationId}`,
    );
    setContactBusy(true);
    setContactError(null);
    setContactCandidates([]);
    try {
      const contact = await createContact(contactTask.organizationId, command, key);
      setPayload((current) =>
        current
          ? {
              ...current,
              actions: current.actions.map((action) =>
                action.organizationId === contactTask.organizationId
                  ? { ...action, contacts: [...action.contacts, contact] }
                  : action,
              ),
            }
          : current,
      );
      setContactTask(null);
      contactMutation.current = null;
      setContactCandidates([]);
    } catch (submitError) {
      if (submitError instanceof ApiError && submitError.problem.duplicateCandidates) {
        setContactCandidates(submitError.problem.duplicateCandidates);
      }
      setContactError(messageFor(submitError));
    } finally {
      setContactBusy(false);
    }
  }

  function openContact(task: TodayAction) {
    setContactTask(task);
    contactMutation.current = null;
    setContactError(null);
    setContactCandidates([]);
    contactLinkMutation.current = null;
  }

  function cancelContact() {
    setContactTask(null);
    contactMutation.current = null;
    setContactError(null);
    setContactCandidates([]);
    contactLinkMutation.current = null;
  }

  async function linkExistingContact(contactId: string, command: LinkContactCommand) {
    if (!contactTask) return;
    const key = mutationKey(
      contactLinkMutation,
      command,
      `contact-link:${contactTask.organizationId}:${contactId}`,
    );
    setContactBusy(true);
    setContactError(null);
    try {
      const linked = await linkContact(contactTask.organizationId, contactId, command, key);
      setPayload((current) =>
        current
          ? {
              ...current,
              actions: current.actions.map((action) =>
                action.organizationId === contactTask.organizationId
                  ? { ...action, contacts: [...action.contacts, linked] }
                  : action,
              ),
            }
          : current,
      );
      setContactTask(null);
      contactMutation.current = null;
      setContactCandidates([]);
      contactLinkMutation.current = null;
    } catch (linkError) {
      setContactError(messageFor(linkError));
    } finally {
      setContactBusy(false);
    }
  }

  function openMergeContact(task: TodayAction, contact: ContactOption) {
    mergeReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMergeSource({ task, contact });
    setMergeKey(createIdempotencyKey());
    setMergeError(null);
  }

  function cancelMergeContact() {
    if (mergeBusy) return;
    setMergeSource(null);
    setMergeKey(null);
    setMergeError(null);
    restoreMergeFocus();
  }

  async function submitMergeContact(command: MergeContactCommand) {
    if (!mergeSource || !mergeKey) return;
    setMergeBusy(true);
    setMergeError(null);
    try {
      const result = await mergeContact(mergeSource.contact.id, command, mergeKey);
      setPayload((current) =>
        current
          ? applyContactMerge(current, result.sourceContactId, result.targetContactId)
          : current,
      );
      setMergeNotice(
        `Контакты объединены. Перенесено связей: ${result.movedOrganizationLinks}; ` +
          `закрыто совпадающих связей: ${result.closedConflictingLinks}.`,
      );
      setMergeSource(null);
      setMergeKey(null);
      mergeReturnFocus.current = null;
      window.requestAnimationFrame(() => mergeNoticeRef.current?.focus());
    } catch (submitError) {
      setMergeError(messageFor(submitError));
    } finally {
      setMergeBusy(false);
    }
  }

  function openStageTransition(task: TodayAction) {
    setStageTask(task);
    setStageError(null);
    stageMutation.current = null;
  }

  function cancelStageTransition() {
    if (stageBusy) return;
    setStageTask(null);
    setStageError(null);
    stageMutation.current = null;
  }

  async function submitStageTransition(command: TransitionOpportunityStageCommand) {
    if (!stageTask || !payload) return;
    const currentPayload = payload;
    const key = mutationKey(stageMutation, command, `stage-transition:${stageTask.opportunityId}`);
    setStageBusy(true);
    setStageError(null);
    try {
      const result = await transitionOpportunityStage(stageTask.opportunityId, command, key);
      const nextSelectedId =
        result.toStageCode === "SL"
          ? (currentPayload.actions.find(
              ({ opportunityId }) => opportunityId !== result.opportunityId,
            )?.id ?? null)
          : selectedId;
      setPayload((current) => {
        if (!current) return current;
        const actions =
          result.toStageCode === "SL"
            ? current.actions.filter(({ opportunityId }) => opportunityId !== result.opportunityId)
            : current.actions.map((action) =>
                action.opportunityId === result.opportunityId
                  ? {
                      ...action,
                      opportunityVersion: result.version,
                      opportunityStatus: result.status,
                      opportunityStageData: result.stageData,
                      stageCode: result.toStageCode,
                      stageLabel: result.stageLabel,
                      ...(result.toStageCode === "SX"
                        ? {
                            group: "waiting" as const,
                            dueAt: command.reviewAt ?? action.dueAt,
                            title: `Вернуться к паузе: ${command.pauseReason ?? command.reason}`,
                          }
                        : {}),
                    }
                  : action,
              );
        return {
          ...current,
          actions,
          summary: {
            ...current.summary,
            stageChanges: current.summary.stageChanges + 1,
            launches: current.summary.launches + (result.toStageCode === "S9" ? 1 : 0),
          },
        };
      });
      if (result.toStageCode === "SL") setSelectedId(nextSelectedId);
      setMergeNotice(`Стадия изменена: ${stageTask.stageLabel} → ${result.stageLabel}.`);
      setStageTask(null);
      stageMutation.current = null;
    } catch (transitionError) {
      if (
        transitionError instanceof ApiError &&
        transitionError.problem.code === "OPPORTUNITY_VERSION_CONFLICT"
      ) {
        setStageTask(null);
        stageMutation.current = null;
        setMergeNotice("Возможность уже изменена. Очередь обновлена; откройте переход повторно.");
        await load();
      } else {
        setStageError(messageFor(transitionError));
      }
    } finally {
      setStageBusy(false);
    }
  }

  function openReschedule(task: TodayAction) {
    setRescheduleTarget(task);
    setRescheduleError(null);
    rescheduleMutation.current = null;
  }

  function cancelReschedule() {
    if (rescheduleBusy) return;
    setRescheduleTarget(null);
    setRescheduleError(null);
    rescheduleMutation.current = null;
  }

  async function submitReschedule(command: RescheduleTaskCommand) {
    if (!rescheduleTarget) return;
    const key = mutationKey(rescheduleMutation, command, `task-reschedule:${rescheduleTarget.id}`);
    setRescheduleBusy(true);
    setRescheduleError(null);
    try {
      const nextPayload = await rescheduleTask(rescheduleTarget.id, command, key);
      setPayload(nextPayload);
      setSelectedId(rescheduleTarget.id);
      setMergeNotice(`Задача «${rescheduleTarget.title}» перенесена.`);
      setRescheduleTarget(null);
      rescheduleMutation.current = null;
    } catch (submitError) {
      setRescheduleError(messageFor(submitError));
    } finally {
      setRescheduleBusy(false);
    }
  }

  function restoreMergeFocus() {
    const element = mergeReturnFocus.current;
    mergeReturnFocus.current = null;
    window.requestAnimationFrame(() => element?.focus());
  }

  if (!session) {
    if (error) {
      return (
        <main className="center-state" role="alert">
          <RefreshCw size={30} aria-hidden="true" />
          <h1>Не удалось загрузить рабочее пространство</h1>
          <p>{error}</p>
          <button className="button button-primary" type="button" onClick={() => void load()}>
            Повторить
          </button>
        </main>
      );
    }
    return (
      <main className="center-state" aria-live="polite">
        <span className="loader" aria-hidden="true" />
        <p>Рассчитываем приоритет действий…</p>
      </main>
    );
  }

  const teamName = payload?.teamName ?? session.scope.teamName ?? "Команда";
  const hasActions = (payload?.actions.length ?? 0) > 0;
  const can = (permission: SessionPayload["permissions"][number]) =>
    session.role === "admin" || session.permissions.includes(permission);
  const canWriteTasks = can("tasks.write");
  const canWriteContacts = can("contacts.write");
  const canWriteStages = can("opportunities.stage.write");

  return (
    <div className="app-shell">
      <Sidebar
        session={session}
        activePage={activePage}
        onNavigate={navigate}
        onLogout={onLogout}
      />
      <ErrorBoundary key={activePage}>
        {activePage === "reports" ? (
          <WeeklyReportPage teamName={teamName} />
        ) : activePage === "settings" ? (
          <SettingsPage teamName={teamName} />
        ) : activePage === "partners" ? (
          <PartnersPage teamName={teamName} onNavigate={navigate} />
        ) : activePage === "radar" ? (
          <RadarPage
            teamName={teamName}
            onOpenToday={(opportunityId) => void openRadarWork(opportunityId)}
          />
        ) : activePage === "placements" ? (
          <PlacementPage teamName={teamName} contexts={placementContexts} />
        ) : activePage === "funnel" ? (
          <FunnelPage
            teamName={teamName}
            onOpenOpportunity={(opportunityId) => {
              const action = payload?.actions.find(
                (candidate) => candidate.opportunityId === opportunityId,
              );
              setSelectedId(action?.id ?? null);
              navigate("today");
            }}
          />
        ) : (
          <main className="main-area">
            <header className="page-header">
              <div>
                <h1>Сегодня</h1>
                <p>
                  {payload
                    ? formatCurrentDate(payload.generatedAt)
                    : "Очередь приоритетных действий"}
                </p>
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
                  onClick={() => selectedTask && openCompletion(selectedTask)}
                  disabled={!selectedTask || !canWriteTasks}
                  title={!canWriteTasks ? "Нет разрешения tasks.write" : undefined}
                >
                  <Send size={17} aria-hidden="true" />
                  Зафиксировать контакт
                </button>
              </div>
            </header>

            {mergeNotice ? (
              <div ref={mergeNoticeRef} className="operation-notice" role="status" tabIndex={-1}>
                <CheckCircle2 size={17} aria-hidden="true" />
                <span>{mergeNotice}</span>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setMergeNotice(null)}
                  aria-label="Скрыть уведомление"
                >
                  ×
                </button>
              </div>
            ) : null}

            {error ? (
              <section className="workspace-frame">
                <div className="empty-state" role="alert">
                  <RefreshCw size={30} aria-hidden="true" />
                  <h2>Не удалось загрузить очередь</h2>
                  <p>{error}</p>
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={() => void load()}
                  >
                    Повторить
                  </button>
                </div>
              </section>
            ) : loading && !payload ? (
              <section className="workspace-frame" aria-live="polite">
                <div className="empty-state">
                  <span className="loader" aria-hidden="true" />
                  <p>Рассчитываем приоритет действий…</p>
                </div>
              </section>
            ) : payload ? (
              <section className="workspace-frame">
                <SummaryStrip summary={payload.summary} />

                {hasActions ? (
                  <div className="work-columns">
                    <div className="queue-pane">
                      <TaskGroups
                        actions={payload.actions}
                        selectedId={selectedId}
                        onSelect={(task) => setSelectedId(task.id)}
                        onComplete={canWriteTasks ? openCompletion : undefined}
                        onReschedule={canWriteTasks ? openReschedule : undefined}
                        onAddContact={canWriteContacts ? openContact : undefined}
                        onChangeStage={canWriteStages ? openStageTransition : undefined}
                      />
                    </div>
                    <DetailPanel
                      task={selectedTask}
                      onClose={() => setSelectedId(null)}
                      onComplete={canWriteTasks ? openCompletion : undefined}
                      onAddContact={canWriteContacts ? openContact : undefined}
                      onMergeContact={canWriteContacts ? openMergeContact : undefined}
                      onChangeStage={canWriteStages ? openStageTransition : undefined}
                      onReschedule={canWriteTasks ? openReschedule : undefined}
                    />
                  </div>
                ) : (
                  <div className="empty-state">
                    <CheckCircle2 size={36} aria-hidden="true" />
                    <h2>Очередь разобрана</h2>
                    <p>Новых действий и просрочек сейчас нет.</p>
                  </div>
                )}

                <footer className="day-summary">
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <strong>Итог дня:</strong>
                  <span>
                    выполнено <b>{payload.summary.completed}</b>
                  </span>
                  <span>
                    перенесено <b>{payload.summary.rescheduled}</b>
                  </span>
                  <span>
                    изменено стадий <b>{payload.summary.stageChanges}</b>
                  </span>
                  <span>
                    запусков <b>{payload.summary.launches}</b>
                  </span>
                </footer>
              </section>
            ) : null}
          </main>
        )}
      </ErrorBoundary>

      {completingTask ? (
        <CompletionDialog
          task={completingTask}
          busy={busy}
          error={formError}
          onCancel={cancelCompletion}
          onSubmit={submitCompletion}
        />
      ) : null}
      {contactTask ? (
        <AddContactDialog
          task={contactTask}
          busy={contactBusy}
          error={contactError}
          candidates={contactCandidates}
          onCancel={cancelContact}
          onSubmit={submitContact}
          onLink={linkExistingContact}
        />
      ) : null}
      {mergeSource ? (
        <MergeContactDialog
          source={mergeSource.contact}
          sourceOrganizationName={mergeSource.task.organizationName}
          targets={mergeTargets}
          busy={mergeBusy}
          error={mergeError}
          onCancel={cancelMergeContact}
          onSubmit={submitMergeContact}
        />
      ) : null}
      {stageTask ? (
        <StageTransitionDialog
          task={stageTask}
          busy={stageBusy}
          error={stageError}
          onCancel={cancelStageTransition}
          onSubmit={submitStageTransition}
        />
      ) : null}
      {rescheduleTarget ? (
        <RescheduleTaskDialog
          task={rescheduleTarget}
          busy={rescheduleBusy}
          error={rescheduleError}
          onCancel={cancelReschedule}
          onSubmit={submitReschedule}
        />
      ) : null}
    </div>
  );
}

function formatCurrentDate(value: string) {
  const formatted = longDateFormat.format(new Date(value));
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}
