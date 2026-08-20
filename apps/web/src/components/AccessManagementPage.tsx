import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Save,
  ShieldCheck,
  UserPlus,
  UserRoundCheck,
  UsersRound,
  X,
} from "lucide-react";
import type {
  AccessAdministrationPayload,
  AccessUserStatus,
  AccessUserView,
  ActorPermission,
  ActorRole,
  CreateAccessUserCommand,
  UpdateAccessUserCommand,
} from "@embed-os/contracts";
import {
  ApiError,
  createAccessUser,
  fetchAccessAdministration,
  updateAccessUser,
} from "../lib/api";
import { messageFor as problemMessage } from "../lib/problem";
import { mutationKey, type MutationKeyState } from "../lib/idempotency";

interface AccessManagementPageProps {
  teamName: string;
}

interface AccessDraft {
  role: ActorRole;
  status: AccessUserStatus;
  permissions: ActorPermission[];
  reason: string;
}

interface CreateAccessDraft {
  subject: string;
  displayName: string;
  email: string;
  teamId: string | null;
  role: ActorRole;
  permissions: ActorPermission[];
  reason: string;
}

const roleLabels: Record<ActorRole, string> = {
  partner_manager: "Менеджер партнёров",
  team_lead: "Руководитель команды",
  technical_specialist: "Технический специалист",
  analyst: "Аналитик",
  legal: "Юрист",
  admin: "Администратор",
  observer: "Наблюдатель",
};

const permissionLabels: Record<ActorPermission, string> = {
  "today.read": "Просматривать очередь «Сегодня»",
  "tasks.write": "Завершать и переносить задачи",
  "partners.read": "Просматривать партнёров",
  "partners.write": "Изменять партнёров",
  "partners.export": "Экспортировать партнёров",
  "partners.export.audit": "Просматривать аудит экспорта",
  "contacts.view": "Просматривать контакты",
  "contacts.write": "Изменять и объединять контакты",
  "opportunities.read": "Просматривать воронку",
  "opportunities.stage.write": "Менять стадии возможностей",
  "radar.read": "Просматривать Радар",
  "radar.write": "Проверять и принимать кандидатов",
  "placements.read": "Просматривать размещения",
  "placements.write": "Изменять и проверять размещения",
  "reports.view": "Просматривать отчёты",
  "reports.generate": "Публиковать отчёты",
  "imports.organizations.write": "Импортировать организации",
  "system.admin": "Управлять системными настройками",
};

const permissionGroups: Array<{
  label: string;
  permissions: ActorPermission[];
}> = [
  {
    label: "Работа с партнёрами",
    permissions: [
      "today.read",
      "tasks.write",
      "partners.read",
      "partners.write",
      "partners.export",
      "partners.export.audit",
    ],
  },
  {
    label: "Данные и воронка",
    permissions: [
      "contacts.view",
      "contacts.write",
      "opportunities.read",
      "opportunities.stage.write",
      "imports.organizations.write",
    ],
  },
  {
    label: "Радар и размещения",
    permissions: ["radar.read", "radar.write", "placements.read", "placements.write"],
  },
  { label: "Отчёты и система", permissions: ["reports.view", "reports.generate", "system.admin"] },
];

export function AccessManagementPage({ teamName }: AccessManagementPageProps) {
  const [payload, setPayload] = useState<AccessAdministrationPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateAccessDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useRef<MutationKeyState | null>(null);
  const createMutation = useRef<MutationKeyState | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  const selectUser = useCallback((user: AccessUserView) => {
    selectedIdRef.current = user.id;
    setSelectedId(user.id);
    setDraft(draftFor(user));
    setError(null);
    setNotice(null);
    mutation.current = null;
  }, []);

  const applyPayload = useCallback(
    (next: AccessAdministrationPayload) => {
      setPayload(next);
      const nextSelected =
        next.users.find(({ id }) => id === selectedIdRef.current) ??
        next.users.find(({ currentUser }) => !currentUser) ??
        next.users[0] ??
        null;
      if (nextSelected) selectUser(nextSelected);
    },
    [selectUser],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        applyPayload(await fetchAccessAdministration(signal));
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(messageFor(loadError));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [applyPayload],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const selected = useMemo(
    () => payload?.users.find(({ id }) => id === selectedId) ?? null,
    [payload, selectedId],
  );
  const dirty = Boolean(
    selected &&
    draft &&
    (selected.role !== draft.role ||
      selected.status !== draft.status ||
      sorted(selected.permissions) !== sorted(draft.permissions)),
  );

  async function save() {
    if (!payload || !selected || !draft || selected.currentUser) return;
    const command: UpdateAccessUserCommand = {
      version: selected.version,
      role: draft.role,
      status: draft.status,
      permissions: draft.permissions,
      reason: draft.reason.trim(),
    };
    const key = mutationKey(mutation, command, "access-user-update");
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateAccessUser(selected.id, command, key);
      const users = payload.users.map((user) => (user.id === updated.id ? updated : user));
      setPayload({ ...payload, users });
      selectUser(updated);
      setNotice(`Доступ пользователя ${updated.displayName} обновлён.`);
      mutation.current = null;
    } catch (saveError) {
      if (
        saveError instanceof ApiError &&
        saveError.problem.code === "ACCESS_USER_VERSION_CONFLICT"
      ) {
        mutation.current = null;
        setNotice("Права уже изменил другой администратор. Загружена актуальная версия.");
        await load();
      } else {
        setError(messageFor(saveError));
      }
    } finally {
      setSaving(false);
    }
  }

  function beginCreate() {
    if (!payload) return;
    const role: ActorRole = "partner_manager";
    setCreateDraft({
      subject: "",
      displayName: "",
      email: "",
      teamId: payload.teams[0]?.id ?? null,
      role,
      permissions: [...payload.roleDefaults[role]],
      reason: "",
    });
    setCreating(true);
    setError(null);
    setNotice(null);
    createMutation.current = null;
  }

  async function submitCreate() {
    if (!payload || !createDraft) return;
    const command: CreateAccessUserCommand = {
      ...createDraft,
      subject: createDraft.subject.trim(),
      displayName: createDraft.displayName.trim(),
      email: createDraft.email.trim(),
      reason: createDraft.reason.trim(),
    };
    const key = mutationKey(createMutation, command, "access-user-create");
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const created = await createAccessUser(command, key);
      const users = [...payload.users, created].sort((left, right) =>
        left.displayName.localeCompare(right.displayName, "ru"),
      );
      setPayload({ ...payload, users });
      selectUser(created);
      setCreating(false);
      setCreateDraft(null);
      setNotice(`Пользователь ${created.displayName} зарегистрирован и может войти через OIDC.`);
      createMutation.current = null;
    } catch (createError) {
      setError(messageFor(createError));
    } finally {
      setSaving(false);
    }
  }

  function changeRole(role: ActorRole) {
    if (!payload) return;
    setDraft((current) =>
      current
        ? {
            ...current,
            role,
            permissions: [...payload.roleDefaults[role]],
          }
        : current,
    );
    mutation.current = null;
  }

  function togglePermission(permission: ActorPermission) {
    setDraft((current) =>
      current
        ? {
            ...current,
            permissions: current.permissions.includes(permission)
              ? current.permissions.filter((candidate) => candidate !== permission)
              : [...current.permissions, permission],
          }
        : current,
    );
    mutation.current = null;
  }

  function changeCreateRole(role: ActorRole) {
    if (!payload) return;
    setCreateDraft((current) =>
      current
        ? {
            ...current,
            role,
            permissions: [...payload.roleDefaults[role]],
          }
        : current,
    );
    createMutation.current = null;
  }

  return (
    <main className="main-area access-settings-main">
      <header className="page-header access-settings-header">
        <div>
          <h1>Роли и доступ</h1>
          <p>Корпоративные учётные записи и серверные разрешения</p>
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
            className="button button-secondary"
            type="button"
            onClick={beginCreate}
            disabled={loading || creating}
          >
            <UserPlus size={16} aria-hidden="true" />
            Добавить пользователя
          </button>
          <button
            className="button button-primary"
            type="button"
            onClick={() => void save()}
            disabled={
              saving || !dirty || !draft || draft.reason.trim().length < 5 || selected?.currentUser
            }
          >
            <Save size={16} aria-hidden="true" />
            {saving ? "Сохраняем…" : "Сохранить доступ"}
          </button>
        </div>
      </header>

      {notice ? (
        <div className="operation-notice" role="status">
          <CheckCircle2 size={17} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ) : null}
      {error ? (
        <div className="sla-settings-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{error}</span>
          <button className="button button-secondary" type="button" onClick={() => void load()}>
            <RefreshCw size={15} aria-hidden="true" />
            Повторить
          </button>
        </div>
      ) : null}

      {creating && createDraft && payload ? (
        <form
          className="access-create-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
        >
          <div className="access-create-head">
            <div>
              <span className="access-editor-icon">
                <UserPlus size={20} aria-hidden="true" />
              </span>
              <div>
                <h2>Новый корпоративный пользователь</h2>
                <p>
                  Subject должен точно совпасть с claim <code>sub</code> в OIDC-токене.
                </p>
              </div>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Закрыть форму"
              onClick={() => {
                setCreating(false);
                setCreateDraft(null);
              }}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="access-create-fields">
            <label>
              <span>OIDC subject</span>
              <input
                required
                minLength={3}
                maxLength={255}
                autoComplete="off"
                placeholder="00u123… или corp:ivan.petrov"
                value={createDraft.subject}
                onChange={(event) =>
                  setCreateDraft((current) =>
                    current ? { ...current, subject: event.target.value } : current,
                  )
                }
              />
            </label>
            <label>
              <span>Имя</span>
              <input
                required
                minLength={2}
                maxLength={200}
                autoComplete="name"
                placeholder="Иван Петров"
                value={createDraft.displayName}
                onChange={(event) =>
                  setCreateDraft((current) =>
                    current ? { ...current, displayName: event.target.value } : current,
                  )
                }
              />
            </label>
            <label>
              <span>Корпоративный email</span>
              <input
                required
                type="email"
                maxLength={254}
                autoComplete="email"
                placeholder="ivan.petrov@company.ru"
                value={createDraft.email}
                onChange={(event) =>
                  setCreateDraft((current) =>
                    current ? { ...current, email: event.target.value } : current,
                  )
                }
              />
            </label>
            <label>
              <span>Команда</span>
              <select
                value={createDraft.teamId ?? ""}
                onChange={(event) =>
                  setCreateDraft((current) =>
                    current ? { ...current, teamId: event.target.value || null } : current,
                  )
                }
              >
                <option value="">Без команды</option>
                {payload.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Роль</span>
              <select
                value={createDraft.role}
                onChange={(event) => changeCreateRole(event.target.value as ActorRole)}
              >
                {payload.roles.map((role) => (
                  <option value={role} key={role}>
                    {roleLabels[role]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Причина регистрации</span>
              <input
                required
                minLength={5}
                maxLength={1_000}
                placeholder="Например: участник пилота"
                value={createDraft.reason}
                onChange={(event) =>
                  setCreateDraft((current) =>
                    current ? { ...current, reason: event.target.value } : current,
                  )
                }
              />
            </label>
          </div>
          <div className="access-create-actions">
            <span>{createDraft.permissions.length} разрешений по роли</span>
            <button
              className="button button-primary"
              type="submit"
              disabled={
                saving ||
                createDraft.subject.trim().length < 3 ||
                createDraft.displayName.trim().length < 2 ||
                createDraft.reason.trim().length < 5
              }
            >
              <UserPlus size={16} aria-hidden="true" />
              {saving ? "Регистрируем…" : "Зарегистрировать"}
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <section className="sla-settings-loading" aria-live="polite">
          <span className="loader" aria-hidden="true" />
          <p>Загружаем матрицу доступа…</p>
        </section>
      ) : payload && selected && draft ? (
        <div className="access-settings-layout">
          <section className="access-user-list" aria-label="Пользователи">
            <div className="access-user-list-head">
              <strong>Пользователи</strong>
              <span>{payload.users.length}</span>
            </div>
            {payload.users.map((user) => (
              <button
                type="button"
                key={user.id}
                className={
                  user.id === selected.id
                    ? "access-user-row access-user-row-active"
                    : "access-user-row"
                }
                onClick={() => selectUser(user)}
                aria-current={user.id === selected.id ? "true" : undefined}
              >
                <span className="access-user-avatar">{initials(user.displayName)}</span>
                <span>
                  <strong>{user.displayName}</strong>
                  <small>{roleLabels[user.role]}</small>
                </span>
                <i
                  className={
                    user.status === "active"
                      ? "access-status access-status-active"
                      : "access-status"
                  }
                  aria-label={user.status === "active" ? "Активен" : "Отключён"}
                />
              </button>
            ))}
          </section>

          <section className="access-editor">
            <div className="access-editor-head">
              <div>
                <span className="access-editor-icon">
                  <UserRoundCheck size={20} aria-hidden="true" />
                </span>
                <div>
                  <h2>{selected.displayName}</h2>
                  <p>{selected.email}</p>
                </div>
              </div>
              <span
                className={
                  selected.status === "active"
                    ? "access-state-badge access-state-active"
                    : "access-state-badge"
                }
              >
                {selected.status === "active" ? "Активен" : "Отключён"}
              </span>
            </div>
            {selected.currentUser ? (
              <div className="access-self-note">
                <ShieldCheck size={17} aria-hidden="true" />
                <span>
                  Это ваша учётная запись. Самостоятельное изменение доступа заблокировано.
                </span>
              </div>
            ) : null}
            <div className="access-primary-fields">
              <label>
                <span>Роль</span>
                <select
                  value={draft.role}
                  disabled={selected.currentUser}
                  onChange={(event) => changeRole(event.target.value as ActorRole)}
                >
                  {payload.roles.map((role) => (
                    <option value={role} key={role}>
                      {roleLabels[role]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Статус</span>
                <select
                  value={draft.status}
                  disabled={selected.currentUser}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? { ...current, status: event.target.value as AccessUserStatus }
                        : current,
                    )
                  }
                >
                  <option value="active">Активен</option>
                  <option value="inactive">Отключён</option>
                </select>
              </label>
              <label>
                <span>Команда</span>
                <input value={selected.teamName ?? "Без команды"} readOnly />
              </label>
            </div>
            <div className="access-permissions-head">
              <div>
                <h3>Разрешения</h3>
                <p>Роль задаёт стартовый набор, отдельные права можно уточнить.</p>
              </div>
              <span>
                {draft.permissions.length} из {payload.permissions.length}
              </span>
            </div>
            <div className="access-permission-groups">
              {permissionGroups.map((group) => (
                <fieldset key={group.label}>
                  <legend>{group.label}</legend>
                  {group.permissions.map((permission) => (
                    <label key={permission} aria-label={permissionLabels[permission]}>
                      <input
                        type="checkbox"
                        checked={draft.permissions.includes(permission)}
                        disabled={selected.currentUser || draft.role === "admin"}
                        onChange={() => togglePermission(permission)}
                      />
                      <span>
                        <b>{permissionLabels[permission]}</b>
                        <small>{permission}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            <label className="access-reason-field">
              <span>Причина изменения</span>
              <textarea
                value={draft.reason}
                disabled={selected.currentUser}
                maxLength={1_000}
                placeholder="Например: перевод в другую функцию или отзыв доступа"
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, reason: event.target.value } : current,
                  )
                }
              />
              <small>Обязательно для аудита, минимум 5 символов</small>
            </label>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function draftFor(user: AccessUserView): AccessDraft {
  return { role: user.role, status: user.status, permissions: [...user.permissions], reason: "" };
}

function sorted(values: string[]) {
  return [...values].sort().join("|");
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toLocaleUpperCase("ru-RU");
}

function messageFor(error: unknown) {
  return problemMessage(error, "Не удалось обновить доступ");
}
