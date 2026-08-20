import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { RegisterPlacementCommand } from "@embed-os/contracts";

export interface PlacementContextOption {
  organizationId: string;
  opportunityId: string;
  organizationName: string;
}

interface AddPlacementDialogProps {
  contexts: PlacementContextOption[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (command: RegisterPlacementCommand) => Promise<void>;
}

export function AddPlacementDialog({
  contexts,
  busy,
  error,
  onCancel,
  onSubmit,
}: AddPlacementDialogProps) {
  const titleId = useId();
  const firstField = useRef<HTMLSelectElement>(null);
  const [contextId, setContextId] = useState(contexts[0]?.opportunityId ?? "");
  const [pageUrl, setPageUrl] = useState("");
  const [embedType, setEmbedType] = useState<RegisterPlacementCommand["embedType"]>("video");
  const [environment, setEnvironment] =
    useState<RegisterPlacementCommand["environment"]>("production");
  const [businessStatus, setBusinessStatus] =
    useState<RegisterPlacementCommand["businessStatus"]>("active");
  const [launchedAt, setLaunchedAt] = useState(toLocalDateTime(new Date()));

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const context = contexts.find(({ opportunityId }) => opportunityId === contextId);
    if (!context) return;
    await onSubmit({
      organizationId: context.organizationId,
      opportunityId: context.opportunityId,
      pageUrl,
      embedType,
      environment,
      businessStatus,
      ...(businessStatus === "active" && launchedAt
        ? { launchedAt: new Date(launchedAt).toISOString() }
        : {}),
    });
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        className="completion-dialog add-placement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-header">
          <div>
            <span>Новое размещение</span>
            <h2 id={titleId}>Добавить RUTUBE embed</h2>
            <p>Зарегистрируйте страницу партнёра для плановой L0-проверки.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Закрыть"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={(event) => void submit(event)}>
          {contexts.length > 0 ? (
            <div className="placement-form-grid">
              <label className="placement-form-wide">
                Партнёр и возможность
                <select
                  ref={firstField}
                  value={contextId}
                  onChange={(event) => setContextId(event.target.value)}
                  required
                >
                  {contexts.map((context) => (
                    <option value={context.opportunityId} key={context.opportunityId}>
                      {context.organizationName}
                    </option>
                  ))}
                </select>
              </label>

              <label className="placement-form-wide">
                URL страницы
                <input
                  type="url"
                  value={pageUrl}
                  onChange={(event) => setPageUrl(event.target.value)}
                  placeholder="https://partner.ru/articles/video"
                  required
                  maxLength={2000}
                />
              </label>

              <label>
                Тип embed
                <select
                  value={embedType}
                  onChange={(event) => {
                    setEmbedType(event.target.value as RegisterPlacementCommand["embedType"]);
                  }}
                >
                  <option value="video">Видео</option>
                  <option value="live">Трансляция</option>
                  <option value="playlist">Плейлист</option>
                </select>
              </label>

              <label>
                Среда
                <select
                  value={environment}
                  onChange={(event) => {
                    setEnvironment(event.target.value as RegisterPlacementCommand["environment"]);
                  }}
                >
                  <option value="production">Production</option>
                  <option value="staging">Staging</option>
                  <option value="test">Test</option>
                </select>
              </label>

              <label>
                Бизнес-статус
                <select
                  value={businessStatus}
                  onChange={(event) => {
                    setBusinessStatus(
                      event.target.value as RegisterPlacementCommand["businessStatus"],
                    );
                  }}
                >
                  <option value="active">Активно</option>
                  <option value="planned">Запланировано</option>
                  <option value="paused">На паузе</option>
                  <option value="ended">Завершено</option>
                </select>
              </label>

              <label>
                Дата запуска
                <input
                  type="datetime-local"
                  value={launchedAt}
                  onChange={(event) => setLaunchedAt(event.target.value)}
                  required={businessStatus === "active"}
                  disabled={businessStatus !== "active"}
                />
              </label>
            </div>
          ) : (
            <div className="form-error" role="alert">
              Нет доступных возможностей. Сначала создайте партнёра в рабочей воронке.
            </div>
          )}

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
              disabled={busy || contexts.length === 0}
            >
              {busy ? "Добавляем…" : "Добавить размещение"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function toLocalDateTime(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
