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
import { Sidebar } from "./components/Sidebar";
import type { AppPage } from "./components/Sidebar";
import { SummaryStrip } from "./components/SummaryStrip";
import { TaskGroups } from "./components/TaskGroups";
import { DetailPanel } from "./components/DetailPanel";
import { CompletionDialog } from "./components/CompletionDialog";
import { AddContactDialog } from "./components/AddContactDialog";
import { WeeklyReportPage } from "./components/WeeklyReportPage";
import { PlacementPage } from "./components/PlacementPage";
import { FunnelPage } from "./components/FunnelPage";
import { PartnersPage } from "./components/PartnersPage";
import { RadarPage } from "./components/RadarPage";
import { SettingsPage } from "./components/SettingsPage";
import { StageTransitionDialog } from "./components/StageTransitionDialog";
import { RescheduleTaskDialog } from "./components/RescheduleTaskDialog";
import {
  MergeContactDialog,
  type MergeTargetOption,
} from "./components/MergeContactDialog";

interface AppProps {
  onLogout?: () => Promise<void>;
}

export function App({ onLogout }: AppProps) {
  const [activePage, setActivePage] = useState<AppPage>("today");
  const [payload, setPayload] = useState<TodayPayload | null>(null);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completingTask, setCompletingTask] = useState<TodayAction | null>(null);
  const [completionKey, setCompletionKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [contactTask, setContactTask] = useState<TodayAction | null>(null);
  const [contactKey, setContactKey] = useState<string | null>(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactCandidates, setContactCandidates] = useState<ContactCandidate[]>([]);
  const contactLinkKeys = useRef(new Map<string, string>());
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
  const stageMutation = useRef<{ hash: string; key: string } | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<TodayAction | null>(null);
  const [rescheduleBusy, setRescheduleBusy] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const rescheduleMutation = useRef<{ hash: string; key: string } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
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
    }
  }, []);

  async function openRadarWork(opportunityId: string) {
    setError(null);
    try {
      const nextPayload = await fetchToday();
      setPayload(nextPayload);
      setSelectedId(nextPayload.actions.find((action) => action.opportunityId === opportunityId)?.id ?? nextPayload.actions[0]?.id ?? null);
      setActivePage("today");
    } catch (loadError) {
      setError(messageFor(loadError));
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
    () => payload && mergeSource
      ? collectMergeTargets(payload, mergeSource.contact.id)
      : [],
    [payload, mergeSource],
  );
  const placementContexts = useMemo(() => {
    if (!payload) return [];
    const contexts = new Map<string, {
      organizationId: string;
      opportunityId: string;
      organizationName: string;
    }>();
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
      left.organizationName.localeCompare(right.organizationName, "ru"));
  }, [payload]);

  async function submitCompletion(command: CompleteTaskCommand) {
    if (!completingTask || !completionKey) return;
    setBusy(true);
    setFormError(null);
    try {
      const nextPayload = await completeTask(completingTask.id, command, completionKey);
      setPayload(nextPayload);
      setCompletingTask(null);
      setCompletionKey(null);
      setSelectedId(nextPayload.actions[0]?.id ?? null);
    } catch (submitError) {
      setFormError(messageFor(submitError));
    } finally {
      setBusy(false);
    }
  }

  function openCompletion(task: TodayAction) {
    setCompletingTask(task);
    setCompletionKey(createIdempotencyKey());
    setFormError(null);
  }

  function cancelCompletion() {
    setCompletingTask(null);
    setCompletionKey(null);
    setFormError(null);
  }

  async function submitContact(command: CreateContactCommand) {
    if (!contactTask || !contactKey) return;
    setContactBusy(true);
    setContactError(null);
    setContactCandidates([]);
    try {
      const contact = await createContact(
        contactTask.organizationId,
        command,
        contactKey,
      );
      setPayload((current) => current ? {
        ...current,
        actions: current.actions.map((action) =>
          action.organizationId === contactTask.organizationId
            ? { ...action, contacts: [...action.contacts, contact] }
            : action,
        ),
      } : current);
      setContactTask(null);
      setContactKey(null);
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
    setContactKey(createIdempotencyKey());
    setContactError(null);
    setContactCandidates([]);
    contactLinkKeys.current.clear();
  }

  function cancelContact() {
    setContactTask(null);
    setContactKey(null);
    setContactError(null);
    setContactCandidates([]);
    contactLinkKeys.current.clear();
  }

  async function linkExistingContact(contactId: string, command: LinkContactCommand) {
    if (!contactTask) return;
    let idempotencyKey = contactLinkKeys.current.get(contactId);
    if (!idempotencyKey) {
      idempotencyKey = createIdempotencyKey();
      contactLinkKeys.current.set(contactId, idempotencyKey);
    }
    setContactBusy(true);
    setContactError(null);
    try {
      const linked = await linkContact(
        contactTask.organizationId,
        contactId,
        command,
        idempotencyKey,
      );
      setPayload((current) => current ? {
        ...current,
        actions: current.actions.map((action) =>
          action.organizationId === contactTask.organizationId
            ? { ...action, contacts: [...action.contacts, linked] }
            : action,
        ),
      } : current);
      setContactTask(null);
      setContactKey(null);
      setContactCandidates([]);
      contactLinkKeys.current.clear();
    } catch (linkError) {
      setContactError(messageFor(linkError));
    } finally {
      setContactBusy(false);
    }
  }

  function openMergeContact(task: TodayAction, contact: ContactOption) {
    mergeReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
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
      setPayload((current) => current
        ? applyContactMerge(current, result.sourceContactId, result.targetContactId)
        : current);
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
    const hash = JSON.stringify(command);
    if (stageMutation.current?.hash !== hash) {
      stageMutation.current = { hash, key: createIdempotencyKey() };
    }
    setStageBusy(true);
    setStageError(null);
    try {
      const result = await transitionOpportunityStage(
        stageTask.opportunityId,
        command,
        stageMutation.current.key,
      );
      const nextSelectedId = result.toStageCode === "SL"
        ? currentPayload.actions.find(({ opportunityId }) => opportunityId !== result.opportunityId)?.id ?? null
        : selectedId;
      setPayload((current) => {
        if (!current) return current;
        const actions = result.toStageCode === "SL"
          ? current.actions.filter(({ opportunityId }) => opportunityId !== result.opportunityId)
          : current.actions.map((action) => action.opportunityId === result.opportunityId
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
            : action);
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
    const hash = JSON.stringify(command);
    if (rescheduleMutation.current?.hash !== hash) {
      rescheduleMutation.current = { hash, key: createIdempotencyKey() };
    }
    setRescheduleBusy(true);
    setRescheduleError(null);
    try {
      const nextPayload = await rescheduleTask(
        rescheduleTarget.id,
        command,
        rescheduleMutation.current.key,
      );
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

  if (error) {
    return (
      <main className="center-state">
        <RefreshCw size={30} aria-hidden="true" />
        <h1>Не удалось загрузить очередь</h1>
        <p>{error}</p>
        <button className="button button-primary" type="button" onClick={() => void load()}>
          Повторить
        </button>
      </main>
    );
  }

  if (!payload || !session) {
    return (
      <main className="center-state" aria-live="polite">
        <span className="loader" aria-hidden="true" />
        <p>Рассчитываем приоритет действий…</p>
      </main>
    );
  }

  const hasActions = payload.actions.length > 0;
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
        onNavigate={setActivePage}
        onLogout={onLogout}
      />
      {activePage === "reports" ? (
        <WeeklyReportPage teamName={payload.teamName} />
      ) : activePage === "settings" ? (
        <SettingsPage teamName={payload.teamName} />
      ) : activePage === "partners" ? (
        <PartnersPage teamName={payload.teamName} onNavigate={setActivePage} />
      ) : activePage === "radar" ? (
        <RadarPage teamName={payload.teamName} onOpenToday={(opportunityId) => void openRadarWork(opportunityId)} />
      ) : activePage === "placements" ? (
        <PlacementPage teamName={payload.teamName} contexts={placementContexts} />
      ) : activePage === "funnel" ? (
        <FunnelPage
          teamName={payload.teamName}
          onOpenOpportunity={(opportunityId) => {
            const action = payload.actions.find((candidate) =>
              candidate.opportunityId === opportunityId);
            setSelectedId(action?.id ?? null);
            setActivePage("today");
          }}
        />
      ) : (
      <main className="main-area">
        <header className="page-header">
          <div>
            <h1>Сегодня</h1>
            <p>{formatCurrentDate(payload.generatedAt)}</p>
          </div>
          <div className="header-actions">
            <label className="team-select">
              <UsersRound size={17} aria-hidden="true" />
              <span className="sr-only">Команда</span>
              <select defaultValue={payload.teamName}>
                <option>{payload.teamName}</option>
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
          <div
            ref={mergeNoticeRef}
            className="operation-notice"
            role="status"
            tabIndex={-1}
          >
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
            <span>выполнено <b>{payload.summary.completed}</b></span>
            <span>перенесено <b>{payload.summary.rescheduled}</b></span>
            <span>изменено стадий <b>{payload.summary.stageChanges}</b></span>
            <span>запусков <b>{payload.summary.launches}</b></span>
          </footer>
        </section>
      </main>
      )}

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

export function collectMergeTargets(
  payload: TodayPayload,
  sourceContactId: string,
): MergeTargetOption[] {
  const contacts = new Map<string, MergeTargetOption>();
  for (const action of payload.actions) {
    for (const contact of action.contacts) {
      if (contact.id === sourceContactId) continue;
      const current = contacts.get(contact.id);
      if (current) {
        if (!current.organizationNames.includes(action.organizationName)) {
          current.organizationNames.push(action.organizationName);
        }
      } else {
        contacts.set(contact.id, {
          contact,
          organizationNames: [action.organizationName],
        });
      }
    }
  }
  return [...contacts.values()].sort((left, right) =>
    left.contact.fullName.localeCompare(right.contact.fullName, "ru") ||
    left.contact.id.localeCompare(right.contact.id)
  );
}

export function applyContactMerge(
  payload: TodayPayload,
  sourceContactId: string,
  targetContactId: string,
): TodayPayload {
  const target = payload.actions
    .flatMap((action) => action.contacts)
    .find(({ id }) => id === targetContactId);
  if (!target) return payload;

  return {
    ...payload,
    actions: payload.actions.map((action) => {
      const source = action.contacts.find(({ id }) => id === sourceContactId);
      if (!source) return action;
      if (action.contacts.some(({ id }) => id === targetContactId)) {
        return {
          ...action,
          contacts: action.contacts.filter(({ id }) => id !== sourceContactId),
        };
      }
      return {
        ...action,
        contacts: action.contacts.map((contact) => contact.id === sourceContactId
          ? {
              ...target,
              role: source.role,
              department: source.department,
              isPrimary: source.isPrimary,
            }
          : contact),
      };
    }),
  };
}

function messageFor(error: unknown) {
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
  return "Неизвестная ошибка";
}

function formatCurrentDate(value: string) {
  const date = new Date(value);
  const formatted = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function createIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
