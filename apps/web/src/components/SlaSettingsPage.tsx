import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  RefreshCw,
  Save,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type {
  SlaSettingsPayload,
  SlaWorkingStageCode,
  UpdateSlaSettingsCommand,
} from "@embed-os/contracts";
import { ApiError, fetchSlaSettings, updateSlaSettings } from "../lib/api";

interface SlaSettingsPageProps {
  teamName: string;
}

interface SlaDraft {
  escalationAfterDays: number;
  thresholds: Record<SlaWorkingStageCode, number>;
  reason: string;
}

export function SlaSettingsPage({ teamName }: SlaSettingsPageProps) {
  const [settings, setSettings] = useState<SlaSettingsPayload | null>(null);
  const [draft, setDraft] = useState<SlaDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useRef<{ hash: string; key: string } | null>(null);

  const applySettings = useCallback((next: SlaSettingsPayload) => {
    setSettings(next);
    setDraft({
      escalationAfterDays: next.escalationAfterDays,
      thresholds: Object.fromEntries(
        next.stages.map(({ code, thresholdDays }) => [code, thresholdDays]),
      ) as Record<SlaWorkingStageCode, number>,
      reason: "",
    });
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      applySettings(await fetchSlaSettings(signal));
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(messageFor(loadError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save() {
    if (!settings || !draft) return;
    const command: UpdateSlaSettingsCommand = {
      version: settings.version,
      escalationAfterDays: draft.escalationAfterDays,
      thresholds: draft.thresholds,
      reason: draft.reason,
    };
    const hash = JSON.stringify(command);
    if (mutation.current?.hash !== hash) {
      mutation.current = { hash, key: createIdempotencyKey() };
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await updateSlaSettings(command, mutation.current.key);
      applySettings(next);
      mutation.current = null;
      setNotice(
        `Версия ${next.version} опубликована. Обновлено возможностей: ${next.affectedOpportunities}.`,
      );
    } catch (saveError) {
      if (
        saveError instanceof ApiError &&
        saveError.problem.code === "SLA_SETTINGS_VERSION_CONFLICT"
      ) {
        mutation.current = null;
        setNotice("Настройки уже изменил другой администратор. Загружена актуальная версия.");
        await load();
      } else {
        setError(messageFor(saveError));
      }
    } finally {
      setSaving(false);
    }
  }

  const dirty = Boolean(settings && draft && (
    draft.escalationAfterDays !== settings.escalationAfterDays ||
    draft.reason.trim().length > 0 ||
    settings.stages.some(({ code, thresholdDays }) => draft.thresholds[code] !== thresholdDays)
  ));

  return (
    <main className="main-area sla-settings-main">
      <header className="page-header sla-settings-header">
        <div>
          <h1>Настройки SLA</h1>
          <p>Пороги бездействия и эскалации по стадиям воронки</p>
        </div>
        <div className="header-actions">
          <label className="team-select">
            <UsersRound size={17} aria-hidden="true" />
            <span className="sr-only">Команда</span>
            <select value={teamName} onChange={() => undefined}>
              <option>{teamName}</option>
            </select>
          </label>
          <button
            className="button button-primary"
            type="button"
            onClick={() => void save()}
            disabled={saving || !draft || draft.reason.trim().length < 5 || !dirty}
          >
            <Save size={16} aria-hidden="true" />
            {saving ? "Публикуем…" : "Опубликовать"}
          </button>
        </div>
      </header>

      {notice ? (
        <div className="operation-notice" role="status">
          <CheckCircle2 size={17} aria-hidden="true" />
          <span>{notice}</span>
          <button className="icon-button" type="button" onClick={() => setNotice(null)} aria-label="Скрыть уведомление">×</button>
        </div>
      ) : null}

      {error ? (
        <div className="sla-settings-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{error}</span>
          <button className="button button-secondary" type="button" onClick={() => void load()}>
            <RefreshCw size={15} aria-hidden="true" />Повторить
          </button>
        </div>
      ) : null}

      {loading ? (
        <section className="sla-settings-loading" aria-live="polite">
          <span className="loader" aria-hidden="true" />
          <p>Загружаем опубликованную конфигурацию…</p>
        </section>
      ) : settings && draft ? (
        <div className="sla-settings-layout">
          <section className="sla-settings-panel">
            <div className="sla-settings-panel-head">
              <div>
                <span className="sla-settings-icon"><Clock3 size={18} aria-hidden="true" /></span>
                <div><h2>Порог бездействия</h2><p>Через сколько дней без активности создать задачу владельцу.</p></div>
              </div>
              <span className="sla-version">Версия {settings.version}</span>
            </div>
            <div className="sla-stage-grid">
              {settings.stages.map((stage) => (
                <label className="sla-stage-field" key={stage.code}>
                  <span><b>{stage.code}</b>{stage.label}</span>
                  <span className="sla-number-input">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      step={1}
                      value={draft.thresholds[stage.code]}
                      onChange={(event) => setDraft((current) => current ? {
                        ...current,
                        thresholds: {
                          ...current.thresholds,
                          [stage.code]: Number(event.target.value),
                        },
                      } : current)}
                      aria-label={`Порог стадии ${stage.label}, дней`}
                    />
                    <small>дн.</small>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <aside className="sla-settings-side">
            <section className="sla-settings-panel sla-escalation-panel">
              <div className="sla-settings-panel-head">
                <div>
                  <span className="sla-settings-icon sla-settings-icon-warning"><AlertTriangle size={18} aria-hidden="true" /></span>
                  <div><h2>Эскалация</h2><p>Срок после первого предупреждения владельцу.</p></div>
                </div>
              </div>
              <label className="sla-escalation-field">
                <span>Эскалировать руководителю через</span>
                <span className="sla-number-input">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={draft.escalationAfterDays}
                    onChange={(event) => setDraft((current) => current ? {
                      ...current,
                      escalationAfterDays: Number(event.target.value),
                    } : current)}
                    aria-label="Срок эскалации, дней"
                  />
                  <small>дн.</small>
                </span>
              </label>
            </section>

            <section className="sla-settings-panel">
              <div className="sla-settings-panel-head">
                <div>
                  <span className="sla-settings-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
                  <div><h2>Публикация</h2><p>Изменение создаст новую неизменяемую версию.</p></div>
                </div>
              </div>
              <dl className="sla-settings-meta">
                <div><dt>Действующая версия</dt><dd>{settings.version}</dd></div>
                <div><dt>Активных возможностей</dt><dd>{settings.affectedOpportunities}</dd></div>
                <div><dt>Опубликована</dt><dd>{formatDate(settings.publishedAt)}</dd></div>
              </dl>
              <label className="sla-reason-field">
                <span>Причина изменения</span>
                <textarea
                  rows={4}
                  maxLength={500}
                  value={draft.reason}
                  onChange={(event) => setDraft((current) => current ? {
                    ...current,
                    reason: event.target.value,
                  } : current)}
                  placeholder="Например: скорректировали сроки после пилота"
                />
                <small>Обязательна для аудита, минимум 5 символов.</small>
              </label>
              <button
                className="button button-secondary sla-reset-button"
                type="button"
                disabled={saving || !dirty}
                onClick={() => applySettings(settings)}
              >
                Сбросить изменения
              </button>
            </section>
          </aside>
        </div>
      ) : null}
    </main>
  );
}

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `sla-settings-${Date.now()}-${Math.random()}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function messageFor(error: unknown) {
  if (error instanceof ApiError) return error.problem.detail;
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}
