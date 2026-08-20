import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Archive, TriangleAlert, X } from "lucide-react";
import type {
  ArchivePlacementCommand,
  PlacementView,
  UpdatePlacementCommand,
} from "@embed-os/contracts";

interface PlacementLifecycleDialogProps {
  placement: PlacementView;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (command: UpdatePlacementCommand) => Promise<void>;
  onArchive: (command: ArchivePlacementCommand) => Promise<void>;
}

export function PlacementLifecycleDialog({
  placement,
  busy,
  error,
  onCancel,
  onSubmit,
  onArchive,
}: PlacementLifecycleDialogProps) {
  const titleId = useId();
  const firstField = useRef<HTMLInputElement>(null);
  const [pageUrl, setPageUrl] = useState(placement.pageUrl);
  const [urlPattern, setUrlPattern] = useState(placement.urlPattern);
  const [embedType, setEmbedType] = useState(placement.embedType);
  const [environment, setEnvironment] = useState(placement.environment);
  const [businessStatus, setBusinessStatus] = useState(placement.businessStatus);
  const [launchedAt, setLaunchedAt] = useState(toLocalDateTime(placement.launchedAt));
  const [reason, setReason] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({
      version: placement.version,
      pageUrl,
      urlPattern,
      embedType,
      environment,
      businessStatus,
      launchedAt: launchedAt ? new Date(launchedAt).toISOString() : null,
      reason,
    });
  }

  async function archive() {
    if (!confirmArchive) {
      setConfirmArchive(true);
      return;
    }
    if (!reason.trim()) return;
    await onArchive({ version: placement.version, reason });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section
        className="completion-dialog add-placement-dialog placement-lifecycle-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-header">
          <div>
            <span>Версия {placement.version}</span>
            <h2 id={titleId}>Управление размещением</h2>
            <p>{placement.organizationName}: параметры и плановый мониторинг.</p>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} disabled={busy} aria-label="Закрыть">
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={(event) => void submit(event)}>
          <div className="placement-form-grid">
            <label className="placement-form-wide">
              URL страницы
              <input
                ref={firstField}
                type="url"
                value={pageUrl}
                onChange={(event) => setPageUrl(event.target.value)}
                required
                maxLength={2000}
              />
            </label>
            <label className="placement-form-wide">
              URL-паттерн
              <input
                value={urlPattern}
                onChange={(event) => setUrlPattern(event.target.value)}
                required
                maxLength={500}
              />
            </label>
            <label>
              Тип embed
              <select value={embedType} onChange={(event) => {
                setEmbedType(event.target.value as PlacementView["embedType"]);
              }}>
                <option value="video">Видео</option>
                <option value="live">Трансляция</option>
                <option value="playlist">Плейлист</option>
              </select>
            </label>
            <label>
              Среда
              <select value={environment} onChange={(event) => {
                setEnvironment(event.target.value as PlacementView["environment"]);
              }}>
                <option value="production">Production</option>
                <option value="staging">Staging</option>
                <option value="test">Test</option>
              </select>
            </label>
            <label>
              Бизнес-статус
              <select value={businessStatus} onChange={(event) => {
                setBusinessStatus(event.target.value as PlacementView["businessStatus"]);
              }}>
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
              />
            </label>
            <label className="placement-form-wide">
              Причина изменения
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Например: партнёр временно снял плеер со страницы"
                required
                maxLength={500}
              />
            </label>
          </div>

          {confirmArchive ? (
            <div className="placement-archive-warning" role="alert">
              <TriangleAlert size={18} aria-hidden="true" />
              <p><strong>Архивировать размещение?</strong> Оно исчезнет из реестра, а плановые проверки и открытая техническая задача будут остановлены.</p>
            </div>
          ) : null}
          {error ? <div className="form-error" role="alert">{error}</div> : null}

          <div className="dialog-actions placement-lifecycle-actions">
            <button
              className="button button-danger"
              type="button"
              onClick={() => void archive()}
              disabled={busy || (confirmArchive && !reason.trim())}
            >
              <Archive size={15} aria-hidden="true" />
              {confirmArchive ? "Подтвердить архив" : "Архивировать"}
            </button>
            <span className="placement-lifecycle-spacer" />
            <button className="button button-secondary" type="button" onClick={onCancel} disabled={busy}>
              Отмена
            </button>
            <button className="button button-primary" type="submit" disabled={busy || !reason.trim()}>
              {busy ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function toLocalDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
