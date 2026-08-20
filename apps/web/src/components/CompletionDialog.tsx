import { useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type {
  CompleteTaskCommand,
  ManualInteractionType,
  TodayAction,
} from "@embed-os/contracts";

interface CompletionDialogProps {
  task: TodayAction;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (command: CompleteTaskCommand) => Promise<void>;
}

export function CompletionDialog({ task, busy, error, onCancel, onSubmit }: CompletionDialogProps) {
  const [contactId, setContactId] = useState(
    () => task.contacts.find(({ isPrimary }) => isPrimary)?.id ?? task.contacts[0]?.id ?? "",
  );
  const [interactionType, setInteractionType] = useState<ManualInteractionType>("email");
  const [outcome, setOutcome] = useState("Контакт состоялся");
  const [summary, setSummary] = useState("");
  const [nextTitle, setNextTitle] = useState("");
  const [dueAt, setDueAt] = useState(defaultDueAt);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSubmit({
      contactId,
      interactionType,
      outcome,
      summary,
      next: {
        mode: "task",
        title: nextTitle,
        dueAt: new Date(dueAt).toISOString(),
      },
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="completion-dialog" role="dialog" aria-modal="true" aria-labelledby="completion-title">
        <div className="dialog-header">
          <div>
            <span>Фиксация взаимодействия</span>
            <h2 id="completion-title">{task.organizationName}</h2>
            <p>{task.title}</p>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} disabled={busy} aria-label="Закрыть">
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit}>
          <label>
            Контакт
            <select
              value={contactId}
              onChange={(event) => setContactId(event.target.value)}
              autoFocus
              required
            >
              {task.contacts.length === 0 ? (
                <option value="">Нет действующих контактов</option>
              ) : task.contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.fullName} · {contact.role}
                </option>
              ))}
            </select>
          </label>
          <label>
            Тип взаимодействия
            <select
              value={interactionType}
              onChange={(event) =>
                setInteractionType(event.target.value as ManualInteractionType)
              }
            >
              <option value="email">Письмо</option>
              <option value="call">Звонок</option>
              <option value="meeting">Встреча</option>
              <option value="messenger">Мессенджер</option>
              <option value="note">Заметка</option>
            </select>
          </label>
          <label>
            Результат
            <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
              <option>Контакт состоялся</option>
              <option>Получен ответ</option>
              <option>Техническая проверка завершена</option>
              <option>Договорённость подтверждена</option>
            </select>
          </label>
          <label>
            Краткое резюме
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Что произошло и о чём договорились"
              maxLength={4000}
              required
            />
          </label>
          <div className="next-step-box">
            <h3>Следующий шаг</h3>
            <p>BR-002: активная возможность не может остаться без следующего действия.</p>
            <label>
              Действие
              <input
                value={nextTitle}
                onChange={(event) => setNextTitle(event.target.value)}
                placeholder="Например, передать примеры интеграции"
                maxLength={200}
                required
              />
            </label>
            <label>
              Срок
              <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} required />
            </label>
          </div>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <div className="dialog-actions">
            <button className="button button-secondary" type="button" onClick={onCancel} disabled={busy}>Отмена</button>
            <button className="button button-primary" type="submit" disabled={busy || !contactId}>
              {busy ? "Сохраняем…" : "Сохранить результат и шаг"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function defaultDueAt() {
  const dueAt = new Date();
  dueAt.setDate(dueAt.getDate() + 1);
  dueAt.setHours(12, 0, 0, 0);
  const localTime = new Date(dueAt.getTime() - dueAt.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}
