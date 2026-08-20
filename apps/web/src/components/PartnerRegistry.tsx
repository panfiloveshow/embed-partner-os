import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardPlus,
  Download,
  ExternalLink,
  FileText,
  Gauge,
  Mail,
  MessageCircle,
  Network,
  Phone,
  PlayCircle,
  Search,
  UserRoundPlus,
  UsersRound,
  Workflow,
} from "lucide-react";
import type {
  PartnerCardPayload,
  PartnerIntegrationStatus,
  PartnerRegistryItem,
  PartnerRegistryPayload,
} from "@embed-os/contracts";
import { exportPartnerRegistry, fetchPartnerCard, fetchPartnerRegistry } from "../lib/api";
import type { PartnerRegistryFilters } from "../lib/api";
import type { AppPage } from "./Sidebar";

interface PartnerRegistryProps {
  onOpenContacts: () => void;
  onNavigate: (page: AppPage) => void;
}

type CardTab =
  | "overview"
  | "contacts"
  | "opportunities"
  | "interactions"
  | "tasks"
  | "placements"
  | "metrics"
  | "documents"
  | "audit";

const cardTabs: Array<{ id: CardTab; label: string }> = [
  { id: "overview", label: "Обзор" },
  { id: "contacts", label: "Контакты" },
  { id: "opportunities", label: "Возможности" },
  { id: "interactions", label: "Взаимодействия" },
  { id: "tasks", label: "Задачи" },
  { id: "placements", label: "Размещения" },
  { id: "metrics", label: "Метрики" },
  { id: "documents", label: "Документы" },
  { id: "audit", label: "Аудит" },
];

export function PartnerRegistry({ onOpenContacts, onNavigate }: PartnerRegistryProps) {
  const [payload, setPayload] = useState<PartnerRegistryPayload | null>(null);
  const [card, setCard] = useState<PartnerCardPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<CardTab>("overview");
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState("");
  const [segment, setSegment] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [stageCode, setStageCode] = useState("");
  const [scoreMin, setScoreMin] = useState("");
  const [integrationStatus, setIntegrationStatus] = useState<PartnerIntegrationStatus | "">("");
  const [activeAfter, setActiveAfter] = useState("");
  const [loading, setLoading] = useState(true);
  const [cardLoading, setCardLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const registryFilters = useMemo<PartnerRegistryFilters>(
    () => ({
      search: search.trim() || undefined,
      groupId: groupId || undefined,
      segment: segment || undefined,
      ownerId: ownerId || undefined,
      stageCode: stageCode || undefined,
      scoreMin: scoreMin ? Number(scoreMin) : undefined,
      integrationStatus: integrationStatus || undefined,
      activeAfter: activeAfter ? new Date(`${activeAfter}T00:00:00.000Z`).toISOString() : undefined,
    }),
    [activeAfter, groupId, integrationStatus, ownerId, scoreMin, search, segment, stageCode],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const next = await fetchPartnerRegistry(registryFilters, signal);
        setPayload(next);
        setSelectedId((current) =>
          next.partners.some(({ id }) => id === current) ? current : (next.partners[0]?.id ?? null),
        );
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить партнёров");
      } finally {
        setLoading(false);
      }
    },
    [registryFilters],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setCard(null);
      return;
    }
    const controller = new AbortController();
    setCardLoading(true);
    setCard(null);
    setTab("overview");
    void fetchPartnerCard(selectedId, controller.signal)
      .then(setCard)
      .catch((cardError) => {
        if (cardError instanceof DOMException && cardError.name === "AbortError") return;
        setError(cardError instanceof Error ? cardError.message : "Не удалось открыть карточку");
      })
      .finally(() => setCardLoading(false));
    return () => controller.abort();
  }, [selectedId]);

  const filtersActive = Boolean(
    search ||
    groupId ||
    segment ||
    ownerId ||
    stageCode ||
    scoreMin ||
    integrationStatus ||
    activeAfter,
  );
  const selected = useMemo(
    () => payload?.partners.find(({ id }) => id === selectedId) ?? null,
    [payload, selectedId],
  );

  function resetFilters() {
    setSearch("");
    setGroupId("");
    setSegment("");
    setOwnerId("");
    setStageCode("");
    setScoreMin("");
    setIntegrationStatus("");
    setActiveAfter("");
  }

  async function exportCurrentRegistry() {
    setExporting(true);
    setExportStatus(null);
    setError(null);
    try {
      const download = await exportPartnerRegistry(registryFilters);
      const objectUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = download.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      const auditReference = download.auditId ? download.auditId.slice(0, 8) : "записан";
      setExportStatus(`CSV готов · аудит ${auditReference}`);
    } catch (exportError) {
      setError(
        exportError instanceof Error ? exportError.message : "Не удалось экспортировать реестр",
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="partner-registry" aria-label="Реестр организаций">
      <div className="partner-registry-toolbar">
        <label className="partner-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Поиск партнёров</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Название, группа, домен или тематика"
          />
        </label>
        <FilterSelect
          label="Группа"
          value={groupId}
          onChange={setGroupId}
          options={
            payload?.filters.groups.map(({ id, name }) => ({ value: id, label: name })) ?? []
          }
        />
        <FilterSelect
          label="Тематика"
          value={segment}
          onChange={setSegment}
          options={payload?.filters.segments.map((value) => ({ value, label: value })) ?? []}
        />
        <FilterSelect
          label="Владелец"
          value={ownerId}
          onChange={setOwnerId}
          options={
            payload?.filters.owners.map(({ id, name }) => ({ value: id, label: name })) ?? []
          }
        />
        <FilterSelect
          label="Стадия"
          value={stageCode}
          onChange={setStageCode}
          options={payload?.filters.stages.map(({ code, label }) => ({ value: code, label })) ?? []}
        />
        <FilterSelect
          label="Score"
          value={scoreMin}
          onChange={setScoreMin}
          options={[
            { value: "70", label: "70+" },
            { value: "50", label: "50+" },
            { value: "30", label: "30+" },
          ]}
        />
        <FilterSelect
          label="Интеграция"
          value={integrationStatus}
          onChange={(value) => setIntegrationStatus(value as PartnerIntegrationStatus | "")}
          options={[
            { value: "not_started", label: "Не начата" },
            { value: "planned", label: "Планируется" },
            { value: "active", label: "Активна" },
            { value: "issue", label: "Есть проблема" },
          ]}
        />
        <label className="partner-date-filter">
          <span>Активность</span>
          <input
            type="date"
            value={activeAfter}
            onChange={(event) => setActiveAfter(event.target.value)}
          />
        </label>
        {filtersActive ? (
          <button className="partner-filter-reset" type="button" onClick={resetFilters}>
            Сбросить
          </button>
        ) : null}
        <button
          className="partner-export-button"
          type="button"
          onClick={() => void exportCurrentRegistry()}
          disabled={exporting}
        >
          <Download size={14} aria-hidden="true" />
          {exporting ? "Готовим…" : "Экспорт CSV"}
        </button>
      </div>

      {exportStatus ? (
        <div className="partner-export-status" role="status">
          <CheckCircle2 size={15} aria-hidden="true" />
          {exportStatus}
        </div>
      ) : null}
      {error ? (
        <div className="partner-registry-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          {error}
        </div>
      ) : null}

      <div className="partner-registry-layout">
        <div className="partner-registry-list">
          {loading && !payload ? (
            <RegistryEmpty loading />
          ) : payload?.partners.length ? (
            <div className="partner-table-scroll">
              <table className="partner-table">
                <thead>
                  <tr>
                    <th>Партнёр</th>
                    <th>Тематика</th>
                    <th>Владелец</th>
                    <th>Стадия</th>
                    <th>Score</th>
                    <th>Интеграция</th>
                    <th>Активность</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.partners.map((partner) => (
                    <PartnerRow
                      key={partner.id}
                      partner={partner}
                      selected={partner.id === selectedId}
                      onSelect={() => setSelectedId(partner.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <RegistryEmpty />
          )}
          <div className="partner-registry-count">
            Показано {payload?.partners.length ?? 0} из {payload?.total ?? 0}
            {payload?.truncated ? " · выдача ограничена" : ""}
          </div>
        </div>

        <aside className="partner-card" aria-live="polite">
          {cardLoading && !card ? (
            <RegistryEmpty loading />
          ) : card && selected ? (
            <>
              <PartnerCardHeader card={card} onShowMetrics={() => setTab("metrics")} />
              <div
                className="partner-card-tabs"
                role="tablist"
                aria-label="Разделы карточки партнёра"
              >
                {cardTabs.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                  >
                    {label}
                    {cardCount(card, id) !== null ? <span>{cardCount(card, id)}</span> : null}
                  </button>
                ))}
              </div>
              <div className="partner-card-body">
                <PartnerCardTab card={card} tab={tab} />
              </div>
              <div className="partner-quick-actions" aria-label="Быстрые действия">
                <button type="button" onClick={onOpenContacts}>
                  <UserRoundPlus size={15} aria-hidden="true" />
                  Зафиксировать контакт
                </button>
                <button type="button" onClick={() => onNavigate("today")}>
                  <ClipboardPlus size={15} aria-hidden="true" />
                  Создать задачу
                </button>
                <button type="button" onClick={() => onNavigate("funnel")}>
                  <Workflow size={15} aria-hidden="true" />
                  Изменить стадию
                </button>
                <button type="button" onClick={() => onNavigate("placements")}>
                  <PlayCircle size={15} aria-hidden="true" />
                  Добавить размещение
                </button>
                <button type="button" onClick={() => onNavigate("placements")}>
                  <Gauge size={15} aria-hidden="true" />
                  Запустить проверку
                </button>
              </div>
            </>
          ) : (
            <RegistryEmpty prompt />
          )}
        </aside>
      </div>
    </section>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="partner-filter">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Все</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PartnerRow({
  partner,
  selected,
  onSelect,
}: {
  partner: PartnerRegistryItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const partnerContext = [partner.primaryDomain, partner.organizationGroup?.name]
    .filter(Boolean)
    .join(" · ");
  return (
    <tr
      className={selected ? "partner-row partner-row-selected" : "partner-row"}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
    >
      <td data-label="Партнёр">
        <span className="partner-monogram" aria-hidden="true">
          {initials(partner.name)}
        </span>
        <span>
          <strong>{partner.name}</strong>
          <small>{partnerContext || "Домен не указан"}</small>
        </span>
      </td>
      <td data-label="Тематика">{partner.segment ?? "—"}</td>
      <td data-label="Владелец">
        <UsersRound size={14} aria-hidden="true" />
        {partner.owner?.name ?? "Не назначен"}
      </td>
      <td data-label="Стадия">
        <span className="partner-stage">{partner.currentStage?.label ?? "Без возможности"}</span>
      </td>
      <td data-label="Score">
        <strong className="partner-score">{partner.partnerScore ?? "—"}</strong>
      </td>
      <td data-label="Интеграция">
        <IntegrationStatus status={partner.integrationStatus} />
      </td>
      <td data-label="Активность">
        {partner.lastActivityAt ? shortDate(partner.lastActivityAt) : "Нет данных"}
      </td>
    </tr>
  );
}

function PartnerCardHeader({
  card,
  onShowMetrics,
}: {
  card: PartnerCardPayload;
  onShowMetrics: () => void;
}) {
  const partner = card.organization;
  return (
    <>
      <div className="partner-card-heading">
        <span className="partner-monogram partner-monogram-large" aria-hidden="true">
          {initials(partner.name)}
        </span>
        <div>
          <h2>{partner.name}</h2>
          <p>{partner.primaryDomain ?? "Домен не указан"}</p>
          <span>
            {partner.segment ?? "Тематика не указана"}
            {partner.organizationGroup ? ` · ${partner.organizationGroup.name}` : ""}
          </span>
        </div>
      </div>
      <div className="partner-card-summary">
        <div>
          <span>Partner Score</span>
          <strong>
            {partner.partnerScore ?? "—"}
            <small>/100</small>
          </strong>
          <button type="button" onClick={onShowMetrics}>
            Показать расчёт
          </button>
        </div>
        <div>
          <span>Владелец</span>
          <strong>{partner.owner?.name ?? "Не назначен"}</strong>
        </div>
        <div>
          <span>Следующее действие</span>
          <strong>{partner.nextAction?.title ?? "Не задано"}</strong>
          <small>{partner.nextAction ? shortDate(partner.nextAction.dueAt) : "—"}</small>
        </div>
        <div>
          <span>Критический статус</span>
          <strong
            className={partner.integrationStatus === "issue" ? "partner-critical" : "partner-ok"}
          >
            {partner.integrationStatus === "issue" ? "Есть проблема" : "Нет"}
          </strong>
        </div>
      </div>
      <div className="partner-card-counts">
        <span>
          <strong>{partner.domains.length}</strong>Домены
        </span>
        <span>
          <strong>{partner.counts.contacts}</strong>Контакты
        </span>
        <span>
          <strong>{partner.counts.opportunities}</strong>Возможности
        </span>
        <span>
          <strong>{partner.counts.tasks}</strong>Задачи
        </span>
        <span>
          <strong>{partner.counts.placements}</strong>Размещения
        </span>
      </div>
    </>
  );
}

function PartnerCardTab({ card, tab }: { card: PartnerCardPayload; tab: CardTab }) {
  const partner = card.organization;
  if (tab === "overview")
    return (
      <div className="partner-overview">
        <div className="partner-overview-grid">
          <section>
            <h3>Домены</h3>
            {partner.domains.length ? (
              partner.domains.map((domain) => (
                <a key={domain.id} href={`https://${domain.host}`} target="_blank" rel="noreferrer">
                  {domain.host}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              ))
            ) : (
              <p>Не указаны</p>
            )}
          </section>
          <section>
            <h3>Юридическое наименование</h3>
            <p>{partner.legalName ?? "Не указано"}</p>
          </section>
        </div>
        <OrganizationGroupSection card={card} />
        <section>
          <h3>Краткая информация о партнёре</h3>
          <p>{card.summary}</p>
        </section>
        <div className="partner-overview-grid">
          <section>
            <h3>Текущая возможность</h3>
            {card.opportunities[0] ? (
              <>
                <strong>{card.opportunities[0].type}</strong>
                <p>Стадия: {card.opportunities[0].stageLabel}</p>
              </>
            ) : (
              <p>Нет активных возможностей</p>
            )}
          </section>
          <section>
            <h3>Последнее взаимодействие</h3>
            {card.interactions[0] ? (
              <>
                <strong>{card.interactions[0].type}</strong>
                <p>{card.interactions[0].summary}</p>
                <small>{shortDate(card.interactions[0].occurredAt)}</small>
              </>
            ) : (
              <p>Взаимодействий нет</p>
            )}
          </section>
          <section>
            <h3>Следующая задача</h3>
            {card.tasks[0] ? (
              <>
                <strong>{card.tasks[0].title}</strong>
                <p>{shortDate(card.tasks[0].dueAt)}</p>
              </>
            ) : (
              <p>Задач нет</p>
            )}
          </section>
          <section>
            <h3>Состояние размещений</h3>
            <strong>
              {card.placements.filter(({ businessStatus }) => businessStatus === "active").length}{" "}
              активных
            </strong>
            <p>
              {card.placements.some(
                ({ healthStatus }) => healthStatus === "failed" || healthStatus === "degraded",
              )
                ? "Требуется внимание"
                : card.placements.length
                  ? "Критичных ошибок нет"
                  : "Размещений пока нет"}
            </p>
          </section>
        </div>
        <section>
          <h3>Документы</h3>
          <p>{card.documents.length ? `${card.documents.length} файлов` : "Нет документов"}</p>
        </section>
      </div>
    );
  if (tab === "contacts")
    return (
      <CardList empty="Контакты не добавлены">
        {card.contacts.map((contact) => (
          <article key={contact.id}>
            <strong>{contact.fullName}</strong>
            <p>
              {contact.organizationLinks[0]?.role ?? "Роль не указана"}
              {contact.organizationLinks[0]?.department
                ? ` · ${contact.organizationLinks[0].department}`
                : ""}
            </p>
            <div className="partner-contact-channels">
              {contact.email ? (
                <span>
                  <Mail size={13} />
                  {contact.email}
                </span>
              ) : null}
              {contact.phone ? (
                <span>
                  <Phone size={13} />
                  {contact.phone}
                </span>
              ) : null}
              {contact.messenger ? (
                <span>
                  <MessageCircle size={13} />
                  {contact.messenger}
                </span>
              ) : null}
            </div>
          </article>
        ))}
      </CardList>
    );
  if (tab === "opportunities")
    return (
      <CardList empty="Возможностей нет">
        {card.opportunities.map((item) => (
          <article key={item.id}>
            <strong>{item.type}</strong>
            <p>
              {item.stageLabel} · Score {item.score}
            </p>
            <small>{item.owner.name}</small>
          </article>
        ))}
      </CardList>
    );
  if (tab === "interactions")
    return (
      <CardList empty="Взаимодействий нет">
        {card.interactions.map((item) => (
          <article key={item.id}>
            <strong>
              {item.type} · {item.contactName ?? "Без контакта"}
            </strong>
            <p>{item.summary}</p>
            <small>
              {shortDate(item.occurredAt)} · {item.authorName}
            </small>
          </article>
        ))}
      </CardList>
    );
  if (tab === "tasks")
    return (
      <CardList empty="Задач нет">
        {card.tasks.map((item) => (
          <article key={item.id}>
            <strong>{item.title}</strong>
            <p>
              {shortDate(item.dueAt)} · {item.status}
            </p>
            <small>{item.ownerName}</small>
          </article>
        ))}
      </CardList>
    );
  if (tab === "placements")
    return (
      <CardList empty="Размещений нет">
        {card.placements.map((item) => (
          <article key={item.id}>
            <strong>{item.pageUrl}</strong>
            <p>
              {item.businessStatus} · {item.healthStatus}
            </p>
            <small>
              {item.lastCheckAt
                ? `Проверено ${shortDate(item.lastCheckAt)}`
                : "Проверок ещё не было"}
            </small>
          </article>
        ))}
      </CardList>
    );
  if (tab === "metrics")
    return (
      <div className="partner-metrics" id="partner-metrics">
        {card.metrics.map((metric) => (
          <article key={metric.code}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>
              {metric.completeness === "complete"
                ? "Полные данные"
                : metric.completeness === "partial"
                  ? "Частичные данные"
                  : "Источник недоступен"}{" "}
              · {shortDate(metric.dataAsOf)}
            </small>
          </article>
        ))}
      </div>
    );
  if (tab === "documents")
    return (
      <CardList empty="Документы не загружены">
        {card.documents.map((item) => (
          <article key={item.id}>
            <strong>
              <FileText size={14} />
              {item.name}
            </strong>
            <p>{item.kind}</p>
            <small>
              {shortDate(item.uploadedAt)} · {item.uploadedBy}
            </small>
          </article>
        ))}
      </CardList>
    );
  return (
    <CardList empty="Событий аудита нет">
      {card.audit.map((item) => (
        <article key={item.id}>
          <strong>{item.summary}</strong>
          <p>
            {item.entityType} · {item.action}
          </p>
          <small>
            {shortDate(item.occurredAt)} · {item.actorName}
          </small>
        </article>
      ))}
    </CardList>
  );
}

function OrganizationGroupSection({ card }: { card: PartnerCardPayload }) {
  const group = card.organizationGroup;
  if (!group) return null;
  return (
    <section className="partner-group-section">
      <h3>
        <Network size={13} aria-hidden="true" />
        Группа организаций
      </h3>
      <strong>{group.name}</strong>
      <div className="partner-group-members">
        {group.members.map((member) => (
          <article
            key={member.id}
            className={
              member.id === card.organization.id ? "partner-group-member-current" : undefined
            }
          >
            <span>
              <b>{member.name}</b>
              {member.id === card.organization.id ? <em>Текущая</em> : null}
            </span>
            <p>{member.legalName ?? "Юридическое лицо не указано"}</p>
            <small>
              {member.domains.length ? member.domains.join(" · ") : "Домены не указаны"}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}

function CardList({ children, empty }: { children: React.ReactNode[]; empty: string }) {
  return children.length ? (
    <div className="partner-card-list">{children}</div>
  ) : (
    <div className="partner-card-empty">
      <CheckCircle2 size={23} aria-hidden="true" />
      <p>{empty}</p>
    </div>
  );
}

function RegistryEmpty({
  loading = false,
  prompt = false,
}: {
  loading?: boolean;
  prompt?: boolean;
}) {
  return (
    <div className="partner-registry-empty">
      {loading ? (
        <span className="loader" aria-hidden="true" />
      ) : (
        <Building2 size={27} aria-hidden="true" />
      )}
      <strong>
        {loading ? "Загружаем партнёров…" : prompt ? "Выберите партнёра" : "Партнёры не найдены"}
      </strong>
      <span>
        {prompt
          ? "Карточка откроется здесь."
          : loading
            ? "Собираем связанную информацию."
            : "Измените поиск или фильтры."}
      </span>
    </div>
  );
}

function IntegrationStatus({ status }: { status: PartnerIntegrationStatus }) {
  const labels: Record<PartnerIntegrationStatus, string> = {
    not_started: "Не начата",
    planned: "Планируется",
    active: "Активна",
    issue: "Проблема",
  };
  return (
    <span className={`partner-integration partner-integration-${status}`}>
      {status === "issue" ? (
        <AlertTriangle size={12} aria-hidden="true" />
      ) : (
        <CheckCircle2 size={12} aria-hidden="true" />
      )}
      {labels[status]}
    </span>
  );
}

function cardCount(card: PartnerCardPayload, tab: CardTab) {
  const counts: Partial<Record<CardTab, number>> = {
    contacts: card.contacts.length,
    opportunities: card.opportunities.length,
    interactions: card.interactions.length,
    tasks: card.tasks.length,
    placements: card.placements.length,
    metrics: card.metrics.length,
    documents: card.documents.length,
    audit: card.audit.length,
  };
  return counts[tab] ?? null;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("ru") ?? "")
    .join("");
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}
