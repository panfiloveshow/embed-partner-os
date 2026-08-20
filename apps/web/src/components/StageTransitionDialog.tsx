import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { GitBranch, TriangleAlert, X } from "lucide-react";
import {
  opportunityStageCatalog,
  type OpportunityStageData,
  type OpportunityStageCode,
  type TodayAction,
  type TransitionOpportunityStageCommand,
} from "@embed-os/contracts";

interface StageTransitionDialogProps {
  task: TodayAction;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (command: TransitionOpportunityStageCommand) => Promise<void>;
}

const workingStages: OpportunityStageCode[] = [
  "S0",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "S8",
  "S9",
  "S10",
];

export function StageTransitionDialog({
  task,
  busy,
  error,
  onCancel,
  onSubmit,
}: StageTransitionDialogProps) {
  const titleId = useId();
  const firstField = useRef<HTMLSelectElement>(null);
  const targets = useMemo(
    () => transitionTargets(task.stageCode as OpportunityStageCode),
    [task.stageCode],
  );
  const [toStageCode, setToStageCode] = useState<OpportunityStageCode>(targets[0] ?? "SX");
  const [reason, setReason] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [reviewAt, setReviewAt] = useState(defaultFutureDate(7));
  const [closeReason, setCloseReason] = useState("");
  const [closeComment, setCloseComment] = useState("");
  const [neverReturn, setNeverReturn] = useState(false);
  const [returnAt, setReturnAt] = useState(defaultFutureDate(90));
  const [stageData, setStageData] = useState<OpportunityStageData>(() =>
    structuredClone(task.opportunityStageData ?? {}),
  );

  useEffect(() => {
    firstField.current?.focus({ preventScroll: true });
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
    const normalizedStageData = normalizeStageDataDates(stageData);
    const base = {
      version: task.opportunityVersion,
      toStageCode,
      reason,
      ...(Object.keys(normalizedStageData).length > 0 ? { stageData: normalizedStageData } : {}),
    };
    if (toStageCode === "SX") {
      await onSubmit({
        ...base,
        pauseReason,
        reviewAt: new Date(reviewAt).toISOString(),
      });
      return;
    }
    if (toStageCode === "SL") {
      await onSubmit({
        ...base,
        closeReason,
        closeComment,
        ...(neverReturn ? { neverReturn: true } : { returnAt: new Date(returnAt).toISOString() }),
      });
      return;
    }
    await onSubmit(base);
  }

  function updateStageData<K extends keyof OpportunityStageData>(
    field: K,
    value: OpportunityStageData[K],
  ) {
    setStageData((current) => ({ ...current, [field]: value }));
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
        className="completion-dialog stage-transition-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-header">
          <div>
            <span>
              Воронка v{task.processVersion} · версия записи {task.opportunityVersion}
            </span>
            <h2 id={titleId}>Изменить стадию</h2>
            <p>
              {task.organizationName}: сейчас «{task.stageLabel}».
            </p>
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
          <label>
            Новая стадия
            <select
              ref={firstField}
              value={toStageCode}
              onChange={(event) => setToStageCode(event.target.value as OpportunityStageCode)}
            >
              {targets.map((code) => (
                <option value={code} key={code}>
                  {stageLabel(code)}
                </option>
              ))}
            </select>
          </label>

          <label>
            Обоснование перехода
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              maxLength={1000}
              placeholder="Какой результат или решение позволяет изменить стадию"
            />
          </label>

          <StageRequiredFields
            task={task}
            target={toStageCode}
            value={stageData}
            onChange={updateStageData}
          />

          {toStageCode === "SX" ? (
            <div className="next-step-box">
              <h3>Параметры паузы</h3>
              <label>
                Причина паузы
                <textarea
                  value={pauseReason}
                  onChange={(event) => setPauseReason(event.target.value)}
                  required
                  maxLength={1000}
                />
              </label>
              <label>
                Вернуться к рассмотрению
                <input
                  type="datetime-local"
                  value={reviewAt}
                  onChange={(event) => setReviewAt(event.target.value)}
                  required
                />
              </label>
            </div>
          ) : null}

          {toStageCode === "SL" ? (
            <div className="next-step-box">
              <h3>Закрытие без запуска</h3>
              <label>
                Причина закрытия
                <select
                  value={closeReason}
                  onChange={(event) => setCloseReason(event.target.value)}
                  required
                >
                  <option value="">Выберите причину</option>
                  <option value="Нет приоритета у партнёра">Нет приоритета у партнёра</option>
                  <option value="Нет ответа">Нет ответа</option>
                  <option value="Коммерческие условия">Коммерческие условия</option>
                  <option value="Технические ограничения">Технические ограничения</option>
                  <option value="Другое">Другое</option>
                </select>
              </label>
              <label>
                Комментарий
                <textarea
                  value={closeComment}
                  onChange={(event) => setCloseComment(event.target.value)}
                  required
                  maxLength={1000}
                />
              </label>
              <label>
                Конкурент или альтернатива <span className="optional-label">при наличии</span>
                <input
                  value={stageData.competitorAlternative ?? ""}
                  onChange={(event) => updateStageData("competitorAlternative", event.target.value)}
                  maxLength={500}
                />
              </label>
              <label className="merge-confirmation">
                <input
                  type="checkbox"
                  checked={neverReturn}
                  onChange={(event) => setNeverReturn(event.target.checked)}
                />
                Не возвращаться к этой возможности
              </label>
              {!neverReturn ? (
                <label>
                  Допустимая дата возврата
                  <input
                    type="datetime-local"
                    value={returnAt}
                    onChange={(event) => setReturnAt(event.target.value)}
                    required
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          {toStageCode === "S9" ? (
            <div className="stage-activation-note">
              <TriangleAlert size={17} aria-hidden="true" />
              <p>
                Сервер разрешит запуск только при активном Placement с датой запуска и успешной
                L0-проверкой.
              </p>
            </div>
          ) : null}

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
              disabled={busy || targets.length === 0}
            >
              <GitBranch size={16} aria-hidden="true" />
              {busy ? "Проверяем…" : "Выполнить переход"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

interface StageRequiredFieldsProps {
  task: TodayAction;
  target: OpportunityStageCode;
  value: OpportunityStageData;
  onChange: <K extends keyof OpportunityStageData>(
    field: K,
    value: OpportunityStageData[K],
  ) => void;
}

function StageRequiredFields({ task, target, value, onChange }: StageRequiredFieldsProps) {
  if (target === "S1") {
    return (
      <fieldset className="stage-required-fields">
        <legend>Минимум стадии «Исследован»</legend>
        <p className="stage-derived-facts">
          Основной домен: {task.domain || "не указан"} · тематика:{" "}
          {task.organizationSegment || "не указана"}
        </p>
        <label>
          География
          <input
            required
            maxLength={200}
            value={value.geography ?? ""}
            onChange={(event) => onChange("geography", event.target.value)}
          />
        </label>
        <label>
          Тип видеоплеера
          <input
            required
            maxLength={200}
            value={value.videoPlayerType ?? ""}
            onChange={(event) => onChange("videoPlayerType", event.target.value)}
          />
        </label>
        <label>
          Источник данных
          <input
            required
            maxLength={500}
            value={value.dataSource ?? ""}
            onChange={(event) => onChange("dataSource", event.target.value)}
          />
        </label>
        <label>
          Дата проверки
          <input
            required
            type="datetime-local"
            value={dateInputValue(value.researchCheckedAt)}
            onChange={(event) => onChange("researchCheckedAt", event.target.value)}
          />
        </label>
      </fieldset>
    );
  }
  if (target === "S2") {
    return (
      <fieldset className="stage-required-fields">
        <legend>Минимум стадии «Квалифицирован»</legend>
        <p className="stage-derived-facts">
          Score: {task.partnerScore ?? "не рассчитан"} · владелец: {task.ownerName} · следующее
          действие: {task.title}
        </p>
        <label>
          Причина приоритета
          <textarea
            required
            maxLength={1000}
            value={value.priorityReason ?? ""}
            onChange={(event) => onChange("priorityReason", event.target.value)}
          />
        </label>
        <label>
          Предполагаемый кейс RUTUBE
          <textarea
            required
            maxLength={1000}
            value={value.rutubeUseCase ?? ""}
            onChange={(event) => onChange("rutubeUseCase", event.target.value)}
          />
        </label>
      </fieldset>
    );
  }
  if (target === "S3") {
    return (
      <div className="stage-requirement-note">
        <strong>Проверка контакта</strong>
        <p>
          Система проверит контакт или канал, дату и тип взаимодействия, его результат и следующий
          шаг. Если чего-то нет, сначала зафиксируйте контакт из карточки задачи.
        </p>
      </div>
    );
  }
  if (target === "S4") {
    return (
      <fieldset className="stage-required-fields">
        <legend>Минимум стадии «Диалог»</legend>
        <label>
          Потребность
          <textarea
            required
            maxLength={1000}
            value={value.need ?? ""}
            onChange={(event) => onChange("need", event.target.value)}
          />
        </label>
        <label>
          Заинтересованные лица <span className="field-help">по одному на строке</span>
          <textarea
            required
            value={(value.stakeholders ?? []).join("\n")}
            onChange={(event) => onChange("stakeholders", lines(event.target.value))}
          />
        </label>
        <label>
          Возражения
          <textarea
            required
            maxLength={1000}
            value={value.objections ?? ""}
            onChange={(event) => onChange("objections", event.target.value)}
            placeholder="Если возражений нет, зафиксируйте это явно"
          />
        </label>
        <label>
          Согласованный срок
          <input
            required
            type="datetime-local"
            value={dateInputValue(value.agreedDueAt)}
            onChange={(event) => onChange("agreedDueAt", event.target.value)}
          />
        </label>
      </fieldset>
    );
  }
  if (target === "S7") {
    return (
      <fieldset className="stage-required-fields">
        <legend>Минимум стадии «Интеграция»</legend>
        <label>
          Тестовый URL
          <input
            required
            type="url"
            maxLength={2000}
            value={value.testUrl ?? ""}
            onChange={(event) => onChange("testUrl", event.target.value)}
          />
        </label>
        <label>
          Технический контакт
          <input
            required
            maxLength={300}
            value={value.technicalContact ?? ""}
            onChange={(event) => onChange("technicalContact", event.target.value)}
          />
        </label>
        <label>
          Тип эмбеда
          <select
            required
            value={value.embedType ?? ""}
            onChange={(event) =>
              onChange("embedType", event.target.value as OpportunityStageData["embedType"])
            }
          >
            <option value="">Выберите тип</option>
            <option value="video">Видео</option>
            <option value="live">Трансляция</option>
            <option value="playlist">Плейлист</option>
          </select>
        </label>
        <label>
          Чек-лист <span className="field-help">по одному пункту на строке</span>
          <textarea
            required
            value={(value.integrationChecklist ?? []).join("\n")}
            onChange={(event) => onChange("integrationChecklist", lines(event.target.value))}
          />
        </label>
        <label>
          Срок запуска
          <input
            required
            type="datetime-local"
            value={dateInputValue(value.launchDueAt)}
            onChange={(event) => onChange("launchDueAt", event.target.value)}
          />
        </label>
      </fieldset>
    );
  }
  if (target === "S8") {
    return (
      <fieldset className="stage-required-fields">
        <legend>Минимум стадии «Пилот»</legend>
        <div className="stage-field-grid">
          <label>
            Начало пилота
            <input
              required
              type="datetime-local"
              value={dateInputValue(value.pilotStartsAt)}
              onChange={(event) => onChange("pilotStartsAt", event.target.value)}
            />
          </label>
          <label>
            Окончание пилота
            <input
              required
              type="datetime-local"
              value={dateInputValue(value.pilotEndsAt)}
              onChange={(event) => onChange("pilotEndsAt", event.target.value)}
            />
          </label>
        </div>
        <label>
          Критерии успеха
          <textarea
            required
            maxLength={1000}
            value={value.successCriteria ?? ""}
            onChange={(event) => onChange("successCriteria", event.target.value)}
          />
        </label>
        <label>
          Контрольная дата
          <input
            required
            type="datetime-local"
            value={dateInputValue(value.pilotReviewAt)}
            onChange={(event) => onChange("pilotReviewAt", event.target.value)}
          />
        </label>
        <label>
          Источник метрик
          <input
            required
            maxLength={500}
            value={value.metricsSource ?? ""}
            onChange={(event) => onChange("metricsSource", event.target.value)}
          />
        </label>
      </fieldset>
    );
  }
  return null;
}

function transitionTargets(current: OpportunityStageCode): OpportunityStageCode[] {
  if (current === "SL") return [];
  if (current === "SX") return [...workingStages, "SL"];
  const index = workingStages.indexOf(current);
  const next = workingStages[index + 1];
  return [
    ...(next ? [next] : []),
    "SX",
    ...(index <= workingStages.indexOf("S8") ? ["SL" as const] : []),
  ];
}

function stageLabel(code: OpportunityStageCode) {
  return opportunityStageCatalog.find((stage) => stage.code === code)?.label ?? code;
}

function defaultFutureDate(days: number) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function dateInputValue(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function normalizeStageDataDates(value: OpportunityStageData): OpportunityStageData {
  const normalized = { ...value };
  const dateFields = [
    "researchCheckedAt",
    "agreedDueAt",
    "launchDueAt",
    "pilotStartsAt",
    "pilotEndsAt",
    "pilotReviewAt",
  ] as const;
  for (const field of dateFields) {
    const raw = normalized[field];
    if (raw) normalized[field] = new Date(raw).toISOString();
  }
  return normalized;
}

function lines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}
