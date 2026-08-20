import { useState } from "react";
import {
  CalendarClock,
  Check,
  ExternalLink,
  GitBranch,
  MoreHorizontal,
  UserPlus,
} from "lucide-react";
import type { ActionGroup, TodayAction } from "@embed-os/contracts";
import { dayMonthFormat, dayMonthTimeFormat } from "../lib/format";

const groupLabels: Record<ActionGroup, string> = {
  critical: "Критично",
  today: "Сегодня",
  later: "Можно позже",
  waiting: "Ожидание",
};

const groupOrder: ActionGroup[] = ["critical", "today", "later", "waiting"];

interface TaskGroupsProps {
  actions: TodayAction[];
  selectedId: string | null;
  onSelect: (task: TodayAction) => void;
  onComplete?: (task: TodayAction) => void;
  onReschedule?: (task: TodayAction) => void;
  onAddContact?: (task: TodayAction) => void;
  onChangeStage?: (task: TodayAction) => void;
}

export function TaskGroups({
  actions,
  selectedId,
  onSelect,
  onComplete,
  onReschedule,
  onAddContact,
  onChangeStage,
}: TaskGroupsProps) {
  const [todayExpanded, setTodayExpanded] = useState(false);
  const [moreTaskId, setMoreTaskId] = useState<string | null>(null);

  return (
    <div className="task-groups">
      {groupOrder.map((group) => {
        const groupActions = actions.filter((action) => action.group === group);
        if (groupActions.length === 0) return null;
        const visibleActions =
          group === "today" && !todayExpanded ? groupActions.slice(0, 4) : groupActions;
        return (
          <section className={`task-group task-group-${group}`} key={group}>
            <h2>
              {groupLabels[group]} <span>({groupActions.length})</span>
            </h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Организация</th>
                    <th>Стадия</th>
                    <th>Действие</th>
                    <th>Дедлайн</th>
                    <th>Приоритет</th>
                    <th>Причины</th>
                    <th aria-label="Быстрые действия" />
                  </tr>
                </thead>
                <tbody>
                  {visibleActions.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      selected={task.id === selectedId}
                      onSelect={onSelect}
                      onComplete={onComplete}
                      onReschedule={onReschedule}
                      onAddContact={onAddContact}
                      onChangeStage={onChangeStage}
                      moreOpen={moreTaskId === task.id}
                      onToggleMore={() =>
                        setMoreTaskId((current) => (current === task.id ? null : task.id))
                      }
                      onCloseMore={() => setMoreTaskId(null)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {group === "today" && groupActions.length > 4 ? (
              <button
                className="show-more-button"
                type="button"
                onClick={() => setTodayExpanded((expanded) => !expanded)}
              >
                {todayExpanded ? "Свернуть" : `Показать ещё ${groupActions.length - 4}`}
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
  onComplete,
  onReschedule,
  onAddContact,
  onChangeStage,
  moreOpen,
  onToggleMore,
  onCloseMore,
}: {
  task: TodayAction;
  selected: boolean;
  onSelect: (task: TodayAction) => void;
  onComplete?: (task: TodayAction) => void;
  onReschedule?: (task: TodayAction) => void;
  onAddContact?: (task: TodayAction) => void;
  onChangeStage?: (task: TodayAction) => void;
  moreOpen: boolean;
  onToggleMore: () => void;
  onCloseMore: () => void;
}) {
  return (
    <tr className={selected ? "task-row selected" : "task-row"}>
      <td data-label="Организация">
        <button
          className="organization-button"
          type="button"
          onClick={() => onSelect(task)}
          aria-current={selected ? "true" : undefined}
        >
          {task.organizationName}
        </button>
        <span className="domain">{task.domain}</span>
      </td>
      <td data-label="Стадия">
        <span className="stage-label" title={task.stageLabel}>
          {task.stageLabel}
        </span>
      </td>
      <td data-label="Действие" className="task-title-cell">
        {task.title}
      </td>
      <td data-label="Дедлайн" className={deadlineClass(task)}>
        {formatDeadline(task.dueAt, task.group)}
      </td>
      <td data-label="Приоритет">
        <div className="priority-cell">
          <strong>{task.priorityScore || "—"}</strong>
          <span className="priority-track" aria-hidden="true">
            <span style={{ width: `${task.priorityScore}%` }} />
          </span>
        </div>
      </td>
      <td data-label="Причины">
        <div className="reason-list">
          {task.priorityReasons.length > 0
            ? task.priorityReasons
                .slice(0, 2)
                .map((reason) => <span key={`${task.id}-${reason.code}`}>{reason.label}</span>)
            : "—"}
        </div>
      </td>
      <td className="quick-actions">
        <button
          type="button"
          onClick={() => onComplete?.(task)}
          aria-label="Выполнить задачу"
          disabled={!onComplete}
          title={!onComplete ? "Только чтение" : undefined}
        >
          <Check size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onReschedule?.(task)}
          aria-label="Перенести задачу"
          disabled={!onReschedule}
          title={!onReschedule ? "Только чтение" : undefined}
        >
          <CalendarClock size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onSelect(task)} aria-label="Открыть контекст">
          <ExternalLink size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Другие действия"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={onToggleMore}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
        {moreOpen ? (
          <div
            className="task-action-menu"
            role="menu"
            aria-label={`Действия: ${task.organizationName}`}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!onAddContact}
              onClick={() => {
                onCloseMore();
                onAddContact?.(task);
              }}
            >
              <UserPlus size={14} aria-hidden="true" />
              Добавить контакт
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!onReschedule}
              onClick={() => {
                onCloseMore();
                onReschedule?.(task);
              }}
            >
              <CalendarClock size={14} aria-hidden="true" />
              Перенести
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!onChangeStage}
              onClick={() => {
                onCloseMore();
                onChangeStage?.(task);
              }}
            >
              <GitBranch size={14} aria-hidden="true" />
              Изменить стадию
            </button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function deadlineClass(task: TodayAction) {
  return task.group === "critical" ? "deadline overdue" : "deadline";
}

function formatDeadline(value: string | null, group: ActionGroup) {
  if (!value) return "—";
  const date = new Date(value);
  if (group === "waiting") {
    return `Вернуть ${dayMonthFormat.format(date)}`;
  }
  return dayMonthTimeFormat.format(date);
}
