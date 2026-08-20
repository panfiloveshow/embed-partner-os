import {
  ArrowUpRight,
  Check,
  Clock3,
  ExternalLink,
  GitBranch,
  GitMerge,
  UserPlus,
  X,
} from "lucide-react";
import type { ContactOption, TodayAction } from "@embed-os/contracts";
import { shortDateTimeFormat } from "../lib/format";

interface DetailPanelProps {
  task: TodayAction | null;
  onClose: () => void;
  onComplete?: (task: TodayAction) => void;
  onAddContact?: (task: TodayAction) => void;
  onMergeContact?: (task: TodayAction, contact: ContactOption) => void;
  onChangeStage?: (task: TodayAction) => void;
  onReschedule?: (task: TodayAction) => void;
}

export function DetailPanel({
  task,
  onClose,
  onComplete,
  onAddContact,
  onMergeContact,
  onChangeStage,
  onReschedule,
}: DetailPanelProps) {
  if (!task) {
    return (
      <aside className="detail-panel detail-empty">
        <ArrowUpRight size={24} aria-hidden="true" />
        <p>Выберите действие, чтобы увидеть контекст партнёра.</p>
      </aside>
    );
  }

  return (
    <aside className="detail-panel" aria-label={`Контекст: ${task.organizationName}`}>
      <div className="detail-header">
        <div>
          <span className={`severity-label severity-${task.group}`}>{groupLabel(task.group)}</span>
          <h2>{task.organizationName}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="Закрыть контекст"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <dl className="detail-definition-list">
        <div>
          <dt>Сайт</dt>
          <dd>
            {task.domain} <ExternalLink size={13} aria-hidden="true" />
          </dd>
        </div>
        <div>
          <dt>Стадия</dt>
          <dd>
            <span className="stage-label">{task.stageLabel}</span>
          </dd>
        </div>
        <div>
          <dt>Ответственный</dt>
          <dd>{task.ownerName}</dd>
        </div>
      </dl>

      <section className="detail-section">
        <h3>Ближайшее действие</h3>
        <dl className="detail-definition-list">
          <div>
            <dt>Действие</dt>
            <dd>{task.title}</dd>
          </div>
          <div>
            <dt>Дедлайн</dt>
            <dd>{formatLongDate(task.dueAt)}</dd>
          </div>
          <div>
            <dt>Приоритет</dt>
            <dd className="detail-priority">
              <strong>{task.priorityScore} / 100</strong>
              <span className="priority-track">
                <span style={{ width: `${task.priorityScore}%` }} />
              </span>
            </dd>
          </div>
        </dl>
        <div className="detail-reasons">
          {task.priorityReasons.map((reason) => (
            <span key={reason.code}>{reason.label}</span>
          ))}
        </div>
      </section>

      <section className="detail-section">
        <div className="detail-section-heading">
          <h3>Контакты</h3>
          <button
            className="detail-link-button"
            type="button"
            onClick={() => onAddContact?.(task)}
            disabled={!onAddContact}
            title={!onAddContact ? "Только чтение" : undefined}
          >
            <UserPlus size={14} aria-hidden="true" /> Добавить
          </button>
        </div>
        {task.contacts.length > 0 ? (
          <div className="contact-list">
            {task.contacts.map((contact) => (
              <article key={contact.id}>
                <div className="contact-card-heading">
                  <strong>{contact.fullName}</strong>
                  <button
                    className="contact-merge-button"
                    type="button"
                    onClick={() => onMergeContact?.(task, contact)}
                    disabled={!onMergeContact}
                    aria-label={`Объединить контакт ${contact.fullName}`}
                  >
                    <GitMerge size={12} aria-hidden="true" />
                    Объединить
                  </button>
                </div>
                <span>{[contact.role, contact.department].filter(Boolean).join(" · ")}</span>
                <span>
                  {contact.email ?? contact.phone ?? contact.messenger ?? "Канал не указан"}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">Действующих контактов нет</p>
        )}
      </section>

      <section className="detail-section">
        <h3>Последнее взаимодействие</h3>
        {task.lastInteraction ? (
          <>
            <p className="interaction-meta">
              {task.lastInteraction.type} · {formatLongDate(task.lastInteraction.occurredAt)}
            </p>
            <p className="interaction-contact">{task.lastInteraction.contactName}</p>
            <p>{task.lastInteraction.summary}</p>
          </>
        ) : (
          <p className="muted">Взаимодействий ещё нет</p>
        )}
      </section>

      <div className="detail-actions">
        <button
          className="button button-primary"
          type="button"
          onClick={() => onComplete?.(task)}
          disabled={!onComplete}
          title={!onComplete ? "Только чтение" : undefined}
        >
          <Check size={17} aria-hidden="true" /> Выполнить
        </button>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => onReschedule?.(task)}
          disabled={!onReschedule}
          title={!onReschedule ? "Только чтение" : undefined}
        >
          <Clock3 size={17} aria-hidden="true" /> Перенести
        </button>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => onChangeStage?.(task)}
          disabled={!onChangeStage}
          title={!onChangeStage ? "Только чтение" : undefined}
        >
          <GitBranch size={17} aria-hidden="true" /> Изменить стадию
        </button>
      </div>
    </aside>
  );
}

function groupLabel(group: TodayAction["group"]) {
  return { critical: "Критично", today: "Сегодня", later: "Можно позже", waiting: "Ожидание" }[
    group
  ];
}

function formatLongDate(value: string | null) {
  if (!value) return "Не задан";
  return shortDateTimeFormat.format(new Date(value));
}
