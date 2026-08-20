import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  GitMerge,
  Mail,
  MessageCircle,
  Pencil,
  Phone,
  RotateCcw,
  Search,
  UserPlus,
  UsersRound,
} from "lucide-react";
import type {
  ContactRegistryItem,
  ContactRegistryPayload,
  UpdateContactCommand,
} from "@embed-os/contracts";
import {
  archiveContactRecord,
  createContact,
  fetchContactRegistry,
  mergeContact,
  restoreContactRecord,
  updateContactRecord,
} from "../lib/api";
import { messageFor } from "../lib/problem";
import { createIdempotencyKey } from "../lib/idempotency";
import { formatDate } from "../lib/format";

export function ContactRegistry() {
  const [payload, setPayload] = useState<ContactRegistryPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [organizationId, setOrganizationId] = useState("");
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [statusAction, setStatusAction] = useState<"archive" | "restore" | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeReason, setMergeReason] = useState("");

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const next = await fetchContactRegistry(
          {
            search: search.trim() || undefined,
            status,
            organizationId: organizationId || undefined,
            duplicatesOnly,
          },
          signal,
        );
        setPayload(next);
        setSelectedId((current) =>
          next.contacts.some(({ id }) => id === current) ? current : (next.contacts[0]?.id ?? null),
        );
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(registryMessage(loadError));
      } finally {
        setLoading(false);
      }
    },
    [duplicatesOnly, organizationId, search, status],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const selected = payload?.contacts.find(({ id }) => id === selectedId) ?? null;
  const mergeTargets =
    payload?.contacts.filter(
      (contact) => contact.id !== selectedId && contact.status === "active",
    ) ?? [];

  const defaultMergeTargetId = selected?.duplicateMatches[0]?.contactId ?? "";

  useEffect(() => {
    setEditor(null);
    setStatusAction(null);
    setStatusReason("");
    setMergeTargetId(defaultMergeTargetId);
    setMergeReason("");
    setError(null);
  }, [selectedId, defaultMergeTargetId]);

  function replaceContact(contact: ContactRegistryItem) {
    setPayload((current) =>
      current
        ? {
            ...current,
            contacts: current.contacts.map((candidate) =>
              candidate.id === contact.id ? contact : candidate,
            ),
          }
        : current,
    );
    setSelectedId(contact.id);
  }

  async function saveContact(command: UpdateContactCommand) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      replaceContact(
        await updateContactRecord(selected.id, command, createIdempotencyKey("contact-update")),
      );
      setEditor(null);
      setNotice("Контакт обновлён. Изменение сохранено в аудите.");
    } catch (saveError) {
      setError(registryMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function createRegistryContact(
    command: Parameters<typeof createContact>[1] & { organizationId: string },
  ) {
    setBusy(true);
    setError(null);
    try {
      const { organizationId: targetOrganizationId, ...contactCommand } = command;
      const created = await createContact(
        targetOrganizationId,
        contactCommand,
        createIdempotencyKey("contact-create"),
      );
      await load();
      setSelectedId(created.id);
      setEditor(null);
      setNotice("Контакт создан и связан с организацией.");
    } catch (createError) {
      setError(registryMessage(createError));
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus() {
    if (!selected || !statusAction || !statusReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const mutate = statusAction === "archive" ? archiveContactRecord : restoreContactRecord;
      await mutate(
        selected.id,
        { version: selected.version, reason: statusReason },
        createIdempotencyKey(`contact-${statusAction}`),
      );
      setStatusAction(null);
      setStatusReason("");
      setNotice(
        statusAction === "archive" ? "Контакт перемещён в архив." : "Контакт восстановлен.",
      );
      await load();
    } catch (statusError) {
      setError(registryMessage(statusError));
    } finally {
      setBusy(false);
    }
  }

  async function submitMerge(event: FormEvent) {
    event.preventDefault();
    if (!selected || !mergeTargetId || !mergeReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await mergeContact(
        selected.id,
        { targetContactId: mergeTargetId, reason: mergeReason },
        createIdempotencyKey("contact-merge-registry"),
      );
      setNotice("Дубликат объединён: ссылки и история сохранены.");
      setMergeReason("");
      await load();
    } catch (mergeError) {
      setError(registryMessage(mergeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="contact-registry" aria-label="Реестр контактов">
      <div className="contact-registry-toolbar">
        <label className="contact-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Поиск контактов</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по ФИО, организации, email или телефону"
          />
        </label>
        <label>
          <span>Организация</span>
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
          >
            <option value="">Все</option>
            {payload?.organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Статус</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="active">Активные</option>
            <option value="archived">Архив</option>
            <option value="merged">Объединённые</option>
            <option value="all">Все</option>
          </select>
        </label>
        <label className="duplicates-filter">
          <input
            type="checkbox"
            checked={duplicatesOnly}
            onChange={(event) => setDuplicatesOnly(event.target.checked)}
          />
          <span>Только дубли</span>
        </label>
        <button className="button button-primary" type="button" onClick={() => setEditor("create")}>
          <UserPlus size={16} aria-hidden="true" />
          Добавить контакт
        </button>
      </div>

      {notice ? (
        <div className="contact-registry-notice" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="contact-registry-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          {error}
        </div>
      ) : null}
      {editor === "create" && payload ? (
        <ContactCreateForm
          organizations={payload.organizations}
          busy={busy}
          onCancel={() => setEditor(null)}
          onSubmit={createRegistryContact}
        />
      ) : null}

      <div className="contact-registry-layout">
        <div className="contact-registry-list">
          {loading && !payload ? (
            <div className="contact-registry-empty">
              <span className="loader" aria-hidden="true" />
              Загружаем контакты…
            </div>
          ) : payload?.contacts.length ? (
            <div className="contact-table-scroll">
              <table className="contact-registry-table">
                <thead>
                  <tr>
                    <th>ФИО</th>
                    <th>Организация и роль</th>
                    <th>Рабочие каналы</th>
                    <th>Актуальность</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.contacts.map((contact) => (
                    <ContactRow
                      key={contact.id}
                      contact={contact}
                      selected={contact.id === selectedId}
                      onSelect={() => setSelectedId(contact.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="contact-registry-empty">
              <UsersRound size={28} aria-hidden="true" />
              <strong>Контакты не найдены</strong>
              <span>Измените поиск или фильтры.</span>
            </div>
          )}
          <div className="contact-registry-count">
            Показано {payload?.contacts.length ?? 0} из {payload?.total ?? 0}
            {payload?.truncated ? " · выдача ограничена" : ""}
          </div>
        </div>

        <aside className="contact-registry-detail" aria-live="polite">
          {selected ? (
            <>
              <div className="contact-detail-heading">
                <div>
                  <h2>{selected.fullName}</h2>
                  <ContactStatus status={selected.status} />
                </div>
                <span>Версия {selected.version}</span>
              </div>
              {editor === "edit" ? (
                <ContactEditForm
                  contact={selected}
                  busy={busy}
                  onCancel={() => setEditor(null)}
                  onSubmit={saveContact}
                />
              ) : (
                <>
                  <dl className="contact-detail-meta">
                    <div>
                      <dt>Источник</dt>
                      <dd>{selected.source}</dd>
                    </div>
                    <div>
                      <dt>Проверен</dt>
                      <dd>
                        {selected.verifiedAt ? formatDate(selected.verifiedAt) : "Не подтверждён"}
                      </dd>
                    </div>
                    <div>
                      <dt>Обновлён</dt>
                      <dd>{formatDate(selected.updatedAt)}</dd>
                    </div>
                  </dl>
                  <section className="contact-detail-section">
                    <h3>Рабочие каналы</h3>
                    <ContactChannels contact={selected} />
                    <h3>Ограничения коммуникации</h3>
                    <p>{selected.restrictions ?? "Не указаны"}</p>
                  </section>
                  <section className="contact-detail-section">
                    <h3>Организации и роли</h3>
                    {selected.organizationLinks.length ? (
                      selected.organizationLinks.map((link) => (
                        <article className="contact-organization-link" key={link.id}>
                          <strong>{link.organizationName}</strong>
                          <span>
                            {link.role}
                            {link.department ? ` · ${link.department}` : ""}
                          </span>
                        </article>
                      ))
                    ) : (
                      <p>Активных связей нет.</p>
                    )}
                  </section>
                  {selected.duplicateMatches.length ? (
                    <section className="contact-duplicate-warning">
                      <AlertTriangle size={17} aria-hidden="true" />
                      <div>
                        <strong>Найден возможный дубликат</strong>
                        {selected.duplicateMatches.map((match) => (
                          <span key={match.contactId}>
                            {match.fullName}: совпадает {match.matchedOn.join(", ")}
                          </span>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {selected.status === "active" ? (
                    <div className="contact-detail-actions">
                      <button
                        className="button button-secondary"
                        type="button"
                        onClick={() => setEditor("edit")}
                      >
                        <Pencil size={15} aria-hidden="true" />
                        Редактировать
                      </button>
                      <button
                        className="button button-secondary"
                        type="button"
                        onClick={() => setStatusAction("archive")}
                      >
                        <Archive size={15} aria-hidden="true" />
                        Архивировать
                      </button>
                    </div>
                  ) : selected.status === "archived" ? (
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => setStatusAction("restore")}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      Восстановить
                    </button>
                  ) : (
                    <p className="contact-merged-note">
                      Контакт объединён с записью {selected.mergedIntoId}.
                    </p>
                  )}
                  {statusAction ? (
                    <div className="contact-status-confirm">
                      <label>
                        Причина
                        <textarea
                          value={statusReason}
                          onChange={(event) => setStatusReason(event.target.value)}
                          placeholder="Обязательный комментарий"
                        />
                      </label>
                      <div>
                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => setStatusAction(null)}
                        >
                          Отмена
                        </button>
                        <button
                          className="button button-primary"
                          type="button"
                          disabled={busy || !statusReason.trim()}
                          onClick={() => void changeStatus()}
                        >
                          {statusAction === "archive"
                            ? "Подтвердить архив"
                            : "Подтвердить восстановление"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {selected.status === "active" && mergeTargets.length ? (
                    <form className="contact-merge-inline" onSubmit={submitMerge}>
                      <div className="contact-merge-title">
                        <GitMerge size={16} aria-hidden="true" />
                        <strong>Объединить с другим контактом</strong>
                      </div>
                      <label>
                        Целевой контакт
                        <select
                          value={mergeTargetId}
                          onChange={(event) => setMergeTargetId(event.target.value)}
                          required
                        >
                          <option value="">Выберите контакт</option>
                          {mergeTargets.map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.fullName} —{" "}
                              {target.email ?? target.phone ?? target.messenger ?? "без канала"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Причина
                        <textarea
                          value={mergeReason}
                          onChange={(event) => setMergeReason(event.target.value)}
                          placeholder="Почему это один и тот же контакт"
                          required
                        />
                      </label>
                      <button
                        className="button button-secondary"
                        type="submit"
                        disabled={busy || !mergeTargetId || !mergeReason.trim()}
                      >
                        <GitMerge size={15} aria-hidden="true" />
                        Объединить
                      </button>
                    </form>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <div className="contact-registry-empty">
              <UsersRound size={28} aria-hidden="true" />
              <strong>Выберите контакт</strong>
              <span>Карточка откроется здесь.</span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function ContactRow({
  contact,
  selected,
  onSelect,
}: {
  contact: ContactRegistryItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const link = contact.organizationLinks[0];
  return (
    <tr
      className={selected ? "contact-row contact-row-selected" : "contact-row"}
      onClick={onSelect}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
    >
      <td data-label="ФИО">
        <strong>{contact.fullName}</strong>
        {contact.duplicateMatches.length ? (
          <small className="contact-duplicate-mark">Возможный дубль</small>
        ) : null}
      </td>
      <td data-label="Организация и роль">
        <strong>{link?.organizationName ?? "Без организации"}</strong>
        <small>
          {link ? `${link.role}${link.department ? ` · ${link.department}` : ""}` : "—"}
          {contact.organizationLinks.length > 1
            ? ` · ещё ${contact.organizationLinks.length - 1}`
            : ""}
        </small>
      </td>
      <td data-label="Рабочие каналы">
        <ContactChannels contact={contact} compact />
      </td>
      <td data-label="Актуальность">
        {contact.verifiedAt ? formatDate(contact.verifiedAt) : "Не подтверждён"}
      </td>
      <td data-label="Статус">
        <ContactStatus status={contact.status} />
      </td>
    </tr>
  );
}

function ContactChannels({
  contact,
  compact = false,
}: {
  contact: ContactRegistryItem;
  compact?: boolean;
}) {
  const values = [
    contact.email ? { icon: Mail, value: contact.email } : null,
    contact.phone ? { icon: Phone, value: contact.phone } : null,
    contact.messenger ? { icon: MessageCircle, value: contact.messenger } : null,
  ].filter(Boolean) as Array<{ icon: typeof Mail; value: string }>;
  return (
    <div className={compact ? "contact-channels contact-channels-compact" : "contact-channels"}>
      {values.length ? (
        values.map(({ icon: Icon, value }) => (
          <span key={value}>
            <Icon size={compact ? 13 : 15} aria-hidden="true" />
            {compact ? <span className="sr-only">{value}</span> : value}
          </span>
        ))
      ) : (
        <span>Каналы не указаны</span>
      )}
    </div>
  );
}

function ContactStatus({ status }: { status: ContactRegistryItem["status"] }) {
  const label = status === "active" ? "Активен" : status === "archived" ? "Архив" : "Объединён";
  return <span className={`contact-status contact-status-${status}`}>{label}</span>;
}

function ContactCreateForm({
  organizations,
  busy,
  onCancel,
  onSubmit,
}: {
  organizations: ContactRegistryPayload["organizations"];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (
    command: Parameters<typeof createContact>[1] & { organizationId: string },
  ) => Promise<void>;
}) {
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? "");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [messenger, setMessenger] = useState("");
  const [source, setSource] = useState("Ручной ввод");
  const [verifiedAt, setVerifiedAt] = useState("");
  const [restrictions, setRestrictions] = useState("");
  return (
    <form
      className="contact-editor contact-create-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({
          organizationId,
          fullName,
          role,
          ...(department ? { department } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(messenger ? { messenger } : {}),
          source,
          ...(verifiedAt ? { verifiedAt: new Date(verifiedAt).toISOString() } : {}),
          ...(restrictions ? { restrictions } : {}),
        });
      }}
    >
      <div className="contact-editor-heading">
        <strong>Новый контакт</strong>
        <span>Связь с организацией создаётся одной командой.</span>
      </div>
      <div className="contact-editor-grid">
        <label>
          Организация
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            required
          >
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          ФИО
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} required />
        </label>
        <label>
          Роль
          <input value={role} onChange={(event) => setRole(event.target.value)} required />
        </label>
        <label>
          Отдел
          <input value={department} onChange={(event) => setDepartment(event.target.value)} />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Телефон
          <input value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label>
          Мессенджер
          <input value={messenger} onChange={(event) => setMessenger(event.target.value)} />
        </label>
        <label>
          Источник
          <input value={source} onChange={(event) => setSource(event.target.value)} required />
        </label>
        <label>
          Дата актуальности
          <input
            type="datetime-local"
            value={verifiedAt}
            onChange={(event) => setVerifiedAt(event.target.value)}
          />
        </label>
        <label className="contact-editor-wide">
          Ограничения
          <textarea
            value={restrictions}
            onChange={(event) => setRestrictions(event.target.value)}
          />
        </label>
      </div>
      <div className="contact-editor-actions">
        <button className="button button-secondary" type="button" onClick={onCancel}>
          Отмена
        </button>
        <button
          className="button button-primary"
          type="submit"
          disabled={busy || !organizationId || (!email && !phone && !messenger)}
        >
          Создать контакт
        </button>
      </div>
    </form>
  );
}

function ContactEditForm({
  contact,
  busy,
  onCancel,
  onSubmit,
}: {
  contact: ContactRegistryItem;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (command: UpdateContactCommand) => Promise<void>;
}) {
  const link = contact.organizationLinks[0];
  const [fullName, setFullName] = useState(contact.fullName);
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [messenger, setMessenger] = useState(contact.messenger ?? "");
  const [source, setSource] = useState(contact.source);
  const [verifiedAt, setVerifiedAt] = useState(toLocalDateTime(contact.verifiedAt));
  const [restrictions, setRestrictions] = useState(contact.restrictions ?? "");
  const [role, setRole] = useState(link?.role ?? "");
  const [department, setDepartment] = useState(link?.department ?? "");
  return (
    <form
      className="contact-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({
          version: contact.version,
          fullName,
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(messenger ? { messenger } : {}),
          source,
          ...(verifiedAt ? { verifiedAt: new Date(verifiedAt).toISOString() } : {}),
          ...(restrictions ? { restrictions } : {}),
          ...(link
            ? { organizationLink: { id: link.id, role, ...(department ? { department } : {}) } }
            : {}),
        });
      }}
    >
      <div className="contact-editor-heading">
        <strong>Редактирование</strong>
        <span>Изменение защищено версией {contact.version}.</span>
      </div>
      <div className="contact-editor-grid">
        <label>
          ФИО
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} required />
        </label>
        {link ? (
          <>
            <label>
              Роль в {link.organizationName}
              <input value={role} onChange={(event) => setRole(event.target.value)} required />
            </label>
            <label>
              Отдел
              <input value={department} onChange={(event) => setDepartment(event.target.value)} />
            </label>
          </>
        ) : null}
        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Телефон
          <input value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label>
          Мессенджер
          <input value={messenger} onChange={(event) => setMessenger(event.target.value)} />
        </label>
        <label>
          Источник
          <input value={source} onChange={(event) => setSource(event.target.value)} required />
        </label>
        <label>
          Дата актуальности
          <input
            type="datetime-local"
            value={verifiedAt}
            onChange={(event) => setVerifiedAt(event.target.value)}
          />
        </label>
        <label className="contact-editor-wide">
          Ограничения
          <textarea
            value={restrictions}
            onChange={(event) => setRestrictions(event.target.value)}
          />
        </label>
      </div>
      <div className="contact-editor-actions">
        <button className="button button-secondary" type="button" onClick={onCancel}>
          Отмена
        </button>
        <button
          className="button button-primary"
          type="submit"
          disabled={busy || (!email && !phone && !messenger)}
        >
          Сохранить
        </button>
      </div>
    </form>
  );
}

function toLocalDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function registryMessage(error: unknown) {
  return messageFor(error, "Не удалось выполнить действие с контактом");
}
