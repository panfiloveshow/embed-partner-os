import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type {
  ContactCandidate,
  CreateContactCommand,
  LinkContactCommand,
  TodayAction,
} from "@embed-os/contracts";

interface AddContactDialogProps {
  task: TodayAction;
  busy: boolean;
  error: string | null;
  candidates: ContactCandidate[];
  onCancel: () => void;
  onSubmit: (command: CreateContactCommand) => Promise<void>;
  onLink: (contactId: string, command: LinkContactCommand) => Promise<void>;
}

export function AddContactDialog({
  task,
  busy,
  error,
  candidates,
  onCancel,
  onSubmit,
  onLink,
}: AddContactDialogProps) {
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [messenger, setMessenger] = useState("");
  const [restrictions, setRestrictions] = useState("");
  const [channelError, setChannelError] = useState<string | null>(null);
  const candidatesRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  useEffect(() => {
    if (candidates.length > 0) {
      candidatesRef.current?.scrollIntoView({ block: "center" });
    }
  }, [candidates.length]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (![email, phone, messenger].some((value) => value.trim())) {
      setChannelError("Укажите email, телефон или мессенджер");
      return;
    }
    setChannelError(null);
    await onSubmit({
      fullName,
      role,
      ...(department.trim() ? { department } : {}),
      ...(email.trim() ? { email } : {}),
      ...(phone.trim() ? { phone } : {}),
      ...(messenger.trim() ? { messenger } : {}),
      ...(restrictions.trim() ? { restrictions } : {}),
    });
  }

  async function linkCandidate(contactId: string) {
    if (!role.trim()) return;
    await onLink(contactId, {
      role,
      ...(department.trim() ? { department } : {}),
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="completion-dialog add-contact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-contact-title"
      >
        <div className="dialog-header">
          <div>
            <span>Новый контакт</span>
            <h2 id="add-contact-title">{task.organizationName}</h2>
            <p>Каналы будут нормализованы и проверены на дубликаты.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Закрыть"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="contact-form-grid">
            <label>
              Имя и фамилия
              <input
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                maxLength={200}
                autoFocus
                required
              />
            </label>
            <label>
              Роль
              <input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="Например, редактор"
                maxLength={200}
                required
              />
            </label>
            <label className="contact-form-wide">
              Подразделение
              <input
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
                placeholder="Необязательно"
                maxLength={200}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.ru"
                maxLength={320}
              />
            </label>
            <label>
              Телефон
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+7 999 123-45-67"
                maxLength={100}
              />
            </label>
            <label className="contact-form-wide">
              Мессенджер
              <input
                value={messenger}
                onChange={(event) => setMessenger(event.target.value)}
                placeholder="@username"
                maxLength={100}
              />
            </label>
            <label className="contact-form-wide">
              Ограничения коммуникации
              <textarea
                value={restrictions}
                onChange={(event) => setRestrictions(event.target.value)}
                placeholder="Например, звонить только в рабочее время"
                maxLength={2000}
              />
            </label>
          </div>
          {channelError ? <div className="form-error" role="alert">{channelError}</div> : null}
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          {candidates.length > 0 ? (
            <section
              ref={candidatesRef}
              className="duplicate-candidates"
              aria-labelledby="duplicate-candidates-title"
            >
              <div>
                <h3 id="duplicate-candidates-title">Возможные совпадения</h3>
                <p>Связь сохранит роль и подразделение только для этой организации.</p>
              </div>
              {candidates.map((candidate) => (
                <article key={candidate.id}>
                  <div>
                    <strong>{candidate.fullName}</strong>
                    <span>
                      {[candidate.email, candidate.phone, candidate.messenger]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy || candidate.isLinkedToOrganization || !role.trim()}
                    onClick={() => void linkCandidate(candidate.id)}
                  >
                    {candidate.isLinkedToOrganization ? "Уже связан" : "Связать"}
                  </button>
                </article>
              ))}
            </section>
          ) : null}
          <div className="dialog-actions">
            <button className="button button-secondary" type="button" onClick={onCancel} disabled={busy}>
              Отмена
            </button>
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? "Проверяем и сохраняем…" : "Добавить контакт"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
