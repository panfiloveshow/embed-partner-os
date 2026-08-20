import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { GitMerge, ShieldAlert, X } from "lucide-react";
import type { ContactOption, MergeContactCommand } from "@embed-os/contracts";

export interface MergeTargetOption {
  contact: ContactOption;
  organizationNames: string[];
}

interface MergeContactDialogProps {
  source: ContactOption;
  sourceOrganizationName: string;
  targets: MergeTargetOption[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (command: MergeContactCommand) => Promise<void>;
}

export function MergeContactDialog({
  source,
  sourceOrganizationName,
  targets,
  busy,
  error,
  onCancel,
  onSubmit,
}: MergeContactDialogProps) {
  const [targetContactId, setTargetContactId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const target = useMemo(
    () => targets.find(({ contact }) => contact.id === targetContactId),
    [targetContactId, targets],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled)",
        ) ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, onCancel]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!targetContactId || !reason.trim() || !confirmed) return;
    await onSubmit({ targetContactId, reason });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="completion-dialog merge-contact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-contact-title"
        aria-describedby="merge-contact-description"
      >
        <div className="dialog-header">
          <div>
            <span>Слияние контактов</span>
            <h2 id="merge-contact-title">{source.fullName}</h2>
            <p id="merge-contact-description">
              Выберите канонический контакт, в котором продолжится работа.
            </p>
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
          <div className="merge-source-summary">
            <div className="merge-contact-mark" aria-hidden="true">
              <GitMerge size={18} />
            </div>
            <div>
              <span>Будет архивирован</span>
              <strong>{source.fullName}</strong>
              <small>
                {[source.email, source.phone, source.messenger, sourceOrganizationName]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </div>
          </div>

          <label>
            Канонический контакт
            <select
              value={targetContactId}
              onChange={(event) => setTargetContactId(event.target.value)}
              autoFocus
              required
              disabled={busy}
            >
              <option value="">Выберите контакт</option>
              {targets.map(({ contact, organizationNames }) => (
                <option key={contact.id} value={contact.id}>
                  {targetLabel(contact, organizationNames)}
                </option>
              ))}
            </select>
          </label>

          {target ? (
            <div className="merge-target-preview" aria-live="polite">
              <span>Останется рабочим</span>
              <strong>{target.contact.fullName}</strong>
              <small>
                {[
                  target.contact.email,
                  target.contact.phone,
                  target.contact.messenger,
                  ...target.organizationNames,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </div>
          ) : null}

          <label>
            Причина слияния
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Например, совпадают подтверждённые рабочие email и телефон"
              maxLength={1000}
              required
              disabled={busy}
            />
          </label>

          <div className="merge-warning">
            <ShieldAlert size={19} aria-hidden="true" />
            <p>
              Исходная запись не удалится. Её связи и взаимодействия перейдут к выбранному контакту,
              а сам источник останется в истории с причиной слияния.
            </p>
          </div>

          <label className="merge-confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={busy}
            />
            <span>Я проверил контакты и подтверждаю их объединение</span>
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
              disabled={busy || !targetContactId || !reason.trim() || !confirmed}
            >
              <GitMerge size={16} aria-hidden="true" />
              {busy ? "Объединяем…" : "Объединить контакты"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function targetLabel(contact: ContactOption, organizationNames: string[]) {
  const channel = contact.email ?? contact.phone ?? contact.messenger ?? "канал не указан";
  return `${contact.fullName} — ${channel} — ${organizationNames.join(", ")}`;
}
