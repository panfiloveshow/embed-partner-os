import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  RotateCcw,
  Upload,
  UsersRound,
  XCircle,
} from "lucide-react";
import type { OrganizationImportJob, OrganizationImportRow } from "@embed-os/contracts";
import {
  cancelOrganizationImport,
  commitOrganizationImport,
  previewOrganizationImport,
} from "../lib/api";
import { messageFor } from "../lib/problem";
import { createIdempotencyKey, mutationKey, type MutationKeyState } from "../lib/idempotency";
import {
  buildImportCommand,
  importDecisionLabel,
  importRowMessage,
  type ImportResolutions,
  unresolvedImportRows,
} from "../lib/organization-import";
import { ContactRegistry } from "./ContactRegistry";
import { PartnerRegistry } from "./PartnerRegistry";
import type { AppPage } from "./Sidebar";

interface PartnersPageProps {
  teamName: string;
  onNavigate: (page: AppPage) => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function PartnersPage({ teamName, onNavigate }: PartnersPageProps) {
  const [tab, setTab] = useState<"registry" | "import">("registry");
  const [registryMode, setRegistryMode] = useState<"organizations" | "contacts">("organizations");
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelKey = useRef<string | null>(null);
  const commitMutation = useRef<MutationKeyState | null>(null);
  const [job, setJob] = useState<OrganizationImportJob | null>(null);
  const [resolutions, setResolutions] = useState<ImportResolutions>({});
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresolved = useMemo(
    () => (job ? unresolvedImportRows(job, resolutions) : []),
    [job, resolutions],
  );

  async function selectFile(file: File | undefined) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLocaleLowerCase("en-US");
    if (extension !== "csv" && extension !== "xlsx") {
      setError("Поддерживаются только файлы CSV и XLSX.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError("Файл больше 10 МБ. Разделите его на несколько импортов.");
      return;
    }
    setLoading(true);
    setError(null);
    setJob(null);
    setResolutions({});
    cancelKey.current = null;
    commitMutation.current = null;
    try {
      setJob(await previewOrganizationImport(file));
    } catch (previewError) {
      setError(messageFor(previewError));
    } finally {
      setLoading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    void selectFile(event.target.files?.[0]);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!loading && !actionBusy) void selectFile(event.dataTransfer.files[0]);
  }

  function setResolution(row: OrganizationImportRow, value: string) {
    if (value !== "create" && value !== "skip") return;
    if (!row.allowedDecisions.includes(value)) return;
    setResolutions((current) => ({ ...current, [row.rowNo]: value }));
    commitMutation.current = null;
    setError(null);
  }

  async function commit() {
    if (!job || job.status !== "preview" || unresolved.length > 0) return;
    const command = buildImportCommand(job, resolutions);
    const key = mutationKey(commitMutation, command, "organization-import-commit");
    setActionBusy(true);
    setError(null);
    try {
      setJob(await commitOrganizationImport(job.id, command, key));
    } catch (commitError) {
      setError(messageFor(commitError));
    } finally {
      setActionBusy(false);
    }
  }

  async function cancel() {
    if (!job || job.status !== "preview") return;
    cancelKey.current ??= createIdempotencyKey("organization-import-cancel");
    setActionBusy(true);
    setError(null);
    try {
      setJob(await cancelOrganizationImport(job.id, cancelKey.current));
    } catch (cancelError) {
      setError(messageFor(cancelError));
    } finally {
      setActionBusy(false);
    }
  }

  function startAgain() {
    setJob(null);
    setResolutions({});
    setError(null);
    cancelKey.current = null;
    commitMutation.current = null;
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <main className="main-area partners-main">
      <header className="page-header partners-page-header">
        <div>
          <h1>Партнёры</h1>
          <p>Реестр контактов и представительств партнёрских организаций</p>
        </div>
        <label className="team-select">
          <UsersRound size={17} aria-hidden="true" />
          <span className="sr-only">Команда</span>
          <select value={teamName} disabled title="Мультикомандный режим появится позже">
            <option>{teamName}</option>
          </select>
        </label>
      </header>

      <div className="partners-tabs" role="tablist" aria-label="Разделы партнёров">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "registry"}
          onClick={() => setTab("registry")}
        >
          Реестр
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "import"}
          onClick={() => setTab("import")}
        >
          Импорт
        </button>
      </div>

      {tab === "registry" ? (
        <div className="partners-registry-workspace">
          <div className="partners-entity-switch" role="tablist" aria-label="Тип реестра">
            <button
              type="button"
              role="tab"
              aria-selected={registryMode === "organizations"}
              onClick={() => setRegistryMode("organizations")}
            >
              Организации
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={registryMode === "contacts"}
              onClick={() => setRegistryMode("contacts")}
            >
              Контакты
            </button>
          </div>
          {registryMode === "organizations" ? (
            <PartnerRegistry
              onOpenContacts={() => setRegistryMode("contacts")}
              onNavigate={onNavigate}
            />
          ) : (
            <ContactRegistry />
          )}
        </div>
      ) : (
        <section className="partners-workspace" aria-label="Импорт организаций">
          <div className="import-heading">
            <div>
              <span className="eyebrow">Массовая загрузка</span>
              <h2>Импорт CSV / XLSX</h2>
              <p>
                Сначала проверим каждую строку. Данные изменятся только после вашего подтверждения.
              </p>
            </div>
            {job ? (
              <button
                className="button button-secondary"
                type="button"
                onClick={startAgain}
                disabled={actionBusy}
              >
                <RotateCcw size={16} aria-hidden="true" />
                Другой файл
              </button>
            ) : null}
          </div>

          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onFileChange}
            aria-label="Выбрать CSV или XLSX для импорта"
          />

          {!job ? (
            <div
              className={dragging ? "import-dropzone import-dropzone-active" : "import-dropzone"}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              {loading ? (
                <span className="loader" aria-hidden="true" />
              ) : (
                <FileSpreadsheet size={35} aria-hidden="true" />
              )}
              <strong>{loading ? "Проверяем файл…" : "Перетащите файл сюда"}</strong>
              <span>или</span>
              <button
                className="button button-primary"
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={loading}
              >
                <Upload size={16} aria-hidden="true" />
                Выбрать файл
              </button>
              <small>CSV или XLSX · до 10 МБ · до 10 000 строк</small>
            </div>
          ) : (
            <ImportPreview
              job={job}
              resolutions={resolutions}
              unresolvedCount={unresolved.length}
              busy={actionBusy}
              onResolve={setResolution}
              onCommit={() => void commit()}
              onCancel={() => void cancel()}
              onReset={startAgain}
            />
          )}

          {error ? (
            <div className="import-error" role="alert">
              <AlertTriangle size={17} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          {!job ? (
            <div className="import-template-note">
              <strong>Обязательные колонки</strong>
              <code>organization_name</code>
              <code>domain</code>
              <code>source</code>
              <span>Первая строка файла должна содержать заголовки.</span>
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}

function ImportPreview({
  job,
  resolutions,
  unresolvedCount,
  busy,
  onResolve,
  onCommit,
  onCancel,
  onReset,
}: {
  job: OrganizationImportJob;
  resolutions: ImportResolutions;
  unresolvedCount: number;
  busy: boolean;
  onResolve: (row: OrganizationImportRow, value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const finished = job.status !== "preview";
  return (
    <div className="import-preview">
      <div className="import-file-line">
        <FileSpreadsheet size={19} aria-hidden="true" />
        <div>
          <strong>{job.fileName}</strong>
          <span>
            {job.format.toUpperCase()} · {job.summary.total} строк
          </span>
        </div>
        <ImportStatus status={job.status} />
      </div>

      {job.warnings.length > 0 ? (
        <div className="import-warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{job.warnings.join("; ")}</span>
        </div>
      ) : null}

      <div className="import-summary" aria-label="Сводка импорта">
        <SummaryMetric label="Всего" value={job.summary.total} tone="total" />
        <SummaryMetric label="Создать" value={job.summary.create} tone="create" />
        <SummaryMetric label="Обновить" value={job.summary.update} tone="update" />
        <SummaryMetric label="Пропустить" value={job.summary.skip} tone="skip" />
        <SummaryMetric label="Конфликты" value={job.summary.conflict} tone="conflict" />
      </div>

      {job.status === "committed" ? (
        <div className="import-result import-result-success" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>
            Импорт завершён. Применено строк: <strong>{job.summary.applied}</strong>.
          </span>
        </div>
      ) : job.status === "cancelled" ? (
        <div className="import-result import-result-cancelled" role="status">
          <XCircle size={18} aria-hidden="true" />
          <span>Импорт отменён. Реестр не изменён.</span>
        </div>
      ) : unresolvedCount > 0 ? (
        <div className="import-result import-result-attention" role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>
            Осталось решить конфликтов: <strong>{unresolvedCount}</strong>.
          </span>
        </div>
      ) : null}

      <div className="import-table-scroll">
        <table className="import-table">
          <thead>
            <tr>
              <th scope="col">Строка</th>
              <th scope="col">Организация</th>
              <th scope="col">Домен</th>
              <th scope="col">Решение</th>
              <th scope="col">Протокол</th>
            </tr>
          </thead>
          <tbody>
            {job.rows.map((row) => (
              <tr
                key={row.rowNo}
                className={row.decision === "conflict" ? "import-row-conflict" : undefined}
              >
                <td data-label="Строка">{row.rowNo}</td>
                <td data-label="Организация">
                  <strong>{row.values.organization_name || "—"}</strong>
                  <small>{row.values.segment || "Сегмент не указан"}</small>
                </td>
                <td data-label="Домен">
                  <code>{row.normalizedDomain || row.values.domain || "—"}</code>
                </td>
                <td data-label="Решение">
                  {row.decision === "conflict" && job.status === "preview" ? (
                    <label className="import-resolution">
                      <span className="sr-only">Решение для строки {row.rowNo}</span>
                      <select
                        value={resolutions[row.rowNo] ?? ""}
                        onChange={(event) => onResolve(row, event.target.value)}
                        disabled={busy}
                        aria-invalid={!resolutions[row.rowNo]}
                      >
                        <option value="">Выберите</option>
                        {row.allowedDecisions.includes("create") ? (
                          <option value="create">Создать отдельно</option>
                        ) : null}
                        {row.allowedDecisions.includes("skip") ? (
                          <option value="skip">Пропустить</option>
                        ) : null}
                      </select>
                    </label>
                  ) : (
                    <DecisionBadge decision={row.resolvedDecision ?? row.decision} />
                  )}
                </td>
                <td data-label="Протокол">
                  <span>{finished ? protocolMessage(row) : importRowMessage(row)}</span>
                  {row.entityId ? <small>ID: {row.entityId}</small> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="import-actions">
        {job.status === "preview" ? (
          <>
            <button
              className="button button-secondary"
              type="button"
              onClick={onCancel}
              disabled={busy}
            >
              {busy ? "Обработка…" : "Отменить импорт"}
            </button>
            <button
              className="button button-primary"
              type="button"
              onClick={onCommit}
              disabled={busy || unresolvedCount > 0}
            >
              <CheckCircle2 size={16} aria-hidden="true" />
              {busy ? "Применяем…" : "Применить импорт"}
            </button>
          </>
        ) : (
          <button className="button button-primary" type="button" onClick={onReset}>
            <Upload size={16} aria-hidden="true" />
            Новый импорт
          </button>
        )}
      </div>
    </div>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`import-summary-item import-summary-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DecisionBadge({
  decision,
}: {
  decision:
    OrganizationImportRow["decision"] | NonNullable<OrganizationImportRow["resolvedDecision"]>;
}) {
  return (
    <span className={`import-decision import-decision-${decision}`}>
      {importDecisionLabel(decision)}
    </span>
  );
}

function ImportStatus({ status }: { status: OrganizationImportJob["status"] }) {
  const label =
    status === "preview" ? "Предпросмотр" : status === "committed" ? "Завершён" : "Отменён";
  return <span className={`import-job-status import-job-status-${status}`}>{label}</span>;
}

function protocolMessage(row: OrganizationImportRow) {
  if (row.resolvedDecision === "skip") return "Строка пропущена";
  if (row.resolvedDecision === "update") return "Организация обновлена";
  if (row.resolvedDecision === "create") return "Организация создана";
  return "Без изменений";
}
