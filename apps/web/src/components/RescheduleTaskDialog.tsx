import { useEffect, useState, type FormEvent } from "react";
import { CalendarClock, X } from "lucide-react";
import type { RescheduleTaskCommand, TodayAction } from "@embed-os/contracts";

interface RescheduleTaskDialogProps {
  task: TodayAction;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (command: RescheduleTaskCommand) => Promise<void>;
}

const reasons = [
  "Партнёр попросил вернуться позже",
  "Ожидаем материалы или доступы",
  "Внутренняя зависимость",
  "Техническая блокировка",
  "Изменился приоритет",
  "Другая причина",
] as const;

export function RescheduleTaskDialog({
  task,
  busy,
  error,
  onCancel,
  onSubmit,
}: RescheduleTaskDialogProps) {
  const [dueAt, setDueAt] = useState(() => defaultDueAt(task.dueAt));
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedReason =
      reason === "Другая причина"
        ? comment.trim()
        : comment.trim()
          ? `${reason}: ${comment.trim()}`
          : reason;
    await onSubmit({ dueAt: new Date(dueAt).toISOString(), reason: normalizedReason });
  }

  const invalidOther = reason === "Другая причина" && !comment.trim();
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="completion-dialog reschedule-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reschedule-title"
      >
        <div className="dialog-header">
          <div>
            <span>Перенос задачи</span>
            <h2 id="reschedule-title">{task.organizationName}</h2>
            <p>{task.title}</p>
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
          <div className="reschedule-current-deadline">
            <CalendarClock size={18} aria-hidden="true" />
            <span>Текущий срок</span>
            <strong>{formatDeadline(task.dueAt)}</strong>
          </div>
          <label>
            Новый срок
            <input
              type="datetime-local"
              min={minimumDueAt(task.dueAt)}
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            Причина переноса
            <select value={reason} onChange={(event) => setReason(event.target.value)} required>
              <option value="">Выберите причину</option>
              {reasons.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            Комментарий{reason === "Другая причина" ? " (обязательно)" : " (необязательно)"}
            <textarea
              maxLength={1_000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Контекст для руководителя и отчёта"
            />
          </label>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          <div className="dialog-actions">
            <button
              className="button button-secondary"
              type="button"
              onClick={onCancel}
              disabled={busy}
            >
              Отмена
            </button>
            <button
              className="button button-primary"
              type="submit"
              disabled={busy || !dueAt || !reason || invalidOther}
            >
              {busy ? "Переносим…" : "Перенести задачу"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function minimumDueAt(value: string | null) {
  const current = value ? new Date(value) : new Date();
  return localDateTime(new Date(current.getTime() + 60_000));
}

function defaultDueAt(value: string | null) {
  const current = value ? new Date(value) : new Date();
  const base = new Date(Math.max(current.getTime(), Date.now()));
  base.setDate(base.getDate() + 1);
  return localDateTime(base);
}

function localDateTime(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function formatDeadline(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "Не задан";
}
