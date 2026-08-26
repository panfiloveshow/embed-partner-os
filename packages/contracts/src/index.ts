export const actionGroups = ["critical", "today", "later", "waiting"] as const;

export type ActionGroup = (typeof actionGroups)[number];

export interface PriorityReason {
  code: "inbound" | "overdue" | "partner-potential" | "technical-risk" | "inactivity" | "waiting";
  label: string;
}

export interface ContactOption {
  id: string;
  fullName: string;
  role: string;
  department: string | null;
  email: string | null;
  phone: string | null;
  messenger: string | null;
  isPrimary: boolean;
}

export interface CreateContactCommand {
  fullName: string;
  role: string;
  department?: string;
  email?: string;
  phone?: string;
  messenger?: string;
  source?: string;
  verifiedAt?: string;
  restrictions?: string;
}

export interface UpdateContactCommand {
  version: number;
  fullName: string;
  email?: string;
  phone?: string;
  messenger?: string;
  source: string;
  verifiedAt?: string;
  restrictions?: string;
  organizationLink?: {
    id: string;
    role: string;
    department?: string;
  };
}

export interface ChangeContactStatusCommand {
  version: number;
  reason: string;
}

export interface LinkContactCommand {
  role: string;
  department?: string;
}

export interface MergeContactCommand {
  targetContactId: string;
  reason: string;
}

export interface MergeContactResult {
  sourceContactId: string;
  targetContactId: string;
  movedOrganizationLinks: number;
  closedConflictingLinks: number;
  movedInteractions: number;
  outboxEventId: string;
}

export interface ContactCandidate {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  messenger: string | null;
  isLinkedToOrganization: boolean;
}

export type ContactRegistryStatus = "active" | "archived" | "merged";

export interface ContactOrganizationLink {
  id: string;
  organizationId: string;
  organizationName: string;
  role: string;
  department: string | null;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface ContactDuplicateMatch {
  contactId: string;
  fullName: string;
  matchedOn: Array<"email" | "phone" | "messenger">;
}

export interface ContactRegistryItem {
  id: string;
  version: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  messenger: string | null;
  source: string;
  verifiedAt: string | null;
  restrictions: string | null;
  status: ContactRegistryStatus;
  archivedAt: string | null;
  mergedIntoId: string | null;
  updatedAt: string;
  organizationLinks: ContactOrganizationLink[];
  duplicateMatches: ContactDuplicateMatch[];
}

export interface ContactRegistryPayload {
  generatedAt: string;
  total: number;
  truncated: boolean;
  organizations: Array<{ id: string; name: string }>;
  contacts: ContactRegistryItem[];
}

export type PartnerIntegrationStatus = "not_started" | "planned" | "active" | "issue";

export interface OrganizationGroupRef {
  id: string;
  name: string;
}

export interface OrganizationGroupView extends OrganizationGroupRef {
  version: number;
  members: Array<{
    id: string;
    name: string;
    legalName: string | null;
    primaryDomain: string | null;
    domains: string[];
  }>;
}

export interface PartnerRegistryItem {
  id: string;
  version: number;
  name: string;
  legalName: string | null;
  segment: string | null;
  status: string;
  primaryDomain: string | null;
  domains: Array<{
    id: string;
    host: string;
    isPrimary: boolean;
    verifiedAt: string | null;
  }>;
  organizationGroup: OrganizationGroupRef | null;
  owner: { id: string; name: string } | null;
  currentStage: { code: string; label: string } | null;
  partnerScore: number | null;
  integrationStatus: PartnerIntegrationStatus;
  lastActivityAt: string | null;
  nextAction: { id: string; title: string; dueAt: string } | null;
  counts: {
    contacts: number;
    opportunities: number;
    tasks: number;
    placements: number;
    documents: number;
  };
}

export interface PartnerRegistryPayload {
  generatedAt: string;
  teamName: string;
  total: number;
  truncated: boolean;
  filters: {
    groups: OrganizationGroupRef[];
    segments: string[];
    owners: Array<{ id: string; name: string }>;
    stages: Array<{ code: string; label: string }>;
    integrationStatuses: PartnerIntegrationStatus[];
  };
  partners: PartnerRegistryItem[];
}

export interface PartnerExportCommand {
  search?: string;
  groupId?: string;
  segment?: string;
  ownerId?: string;
  stageCode?: string;
  scoreMin?: number;
  scoreMax?: number;
  integrationStatus?: PartnerIntegrationStatus;
  activeAfter?: string;
}

export interface PartnerExportAuditView {
  id: string;
  actorSubject: string;
  permission: "partners.export";
  generatedAt: string;
  rowCount: number;
  fileName: string;
  checksum: string;
  filters: PartnerExportCommand;
}

export interface PartnerOpportunityView {
  id: string;
  type: string;
  stageCode: string;
  stageLabel: string;
  status: string;
  score: number;
  owner: { id: string; name: string };
  nextAction: { id: string; title: string; dueAt: string } | null;
  updatedAt: string;
}

export interface PartnerInteractionView {
  id: string;
  type: string;
  occurredAt: string;
  contactName: string | null;
  authorName: string;
  outcome: string;
  summary: string;
  source: string;
}

export interface PartnerTaskView {
  id: string;
  opportunityId: string;
  title: string;
  dueAt: string;
  status: string;
  ownerName: string;
  outcome: string | null;
}

export interface PartnerMetricView {
  code: "partner_score" | "contacts" | "opportunities" | "active_tasks" | "active_placements";
  label: string;
  value: number;
  dataAsOf: string;
  completeness: "complete" | "partial" | "unavailable";
}

export interface PartnerDocumentView {
  id: string;
  name: string;
  kind: string;
  uploadedAt: string;
  uploadedBy: string;
  downloadUrl: string | null;
}

export interface PartnerAuditView {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string;
  occurredAt: string;
  summary: string;
}

export interface PartnerCardPayload {
  generatedAt: string;
  summary: string;
  organization: PartnerRegistryItem;
  organizationGroup: OrganizationGroupView | null;
  contacts: ContactRegistryItem[];
  opportunities: PartnerOpportunityView[];
  interactions: PartnerInteractionView[];
  tasks: PartnerTaskView[];
  placements: PlacementView[];
  metrics: PartnerMetricView[];
  documents: PartnerDocumentView[];
  audit: PartnerAuditView[];
}

export interface TodayAction {
  id: string;
  organizationId: string;
  organizationName: string;
  domain: string;
  opportunityId: string;
  opportunityVersion: number;
  processVersion: number;
  opportunityStatus: "ACTIVE" | "WAITING" | "PAUSED" | "CLOSED";
  partnerScore?: number;
  organizationSegment?: string | null;
  opportunityStageData?: OpportunityStageData;
  stageCode: string;
  stageLabel: string;
  title: string;
  dueAt: string | null;
  group: ActionGroup;
  priorityScore: number;
  priorityReasons: PriorityReason[];
  ownerName: string;
  contacts: ContactOption[];
  lastInteraction: {
    type: string;
    occurredAt: string;
    contactName: string;
    summary: string;
    outcome?: string;
  } | null;
}

export const opportunityStageCatalog = [
  { code: "S0", label: "Найден" },
  { code: "S1", label: "Исследован" },
  { code: "S2", label: "Квалифицирован" },
  { code: "S3", label: "Первичный контакт" },
  { code: "S4", label: "Диалог" },
  { code: "S5", label: "Предложение" },
  { code: "S6", label: "Согласование" },
  { code: "S7", label: "Интеграция" },
  { code: "S8", label: "Пилот" },
  { code: "S9", label: "Активный" },
  { code: "S10", label: "Развитие" },
  { code: "SX", label: "Приостановлен" },
  { code: "SL", label: "Закрыт без запуска" },
] as const;

export type OpportunityStageCode = (typeof opportunityStageCatalog)[number]["code"];

export interface OpportunityStageData {
  geography?: string;
  videoPlayerType?: string;
  dataSource?: string;
  researchCheckedAt?: string;
  priorityReason?: string;
  rutubeUseCase?: string;
  need?: string;
  stakeholders?: string[];
  objections?: string;
  agreedDueAt?: string;
  testUrl?: string;
  technicalContact?: string;
  embedType?: "video" | "live" | "playlist";
  integrationChecklist?: string[];
  launchDueAt?: string;
  pilotStartsAt?: string;
  pilotEndsAt?: string;
  successCriteria?: string;
  pilotReviewAt?: string;
  metricsSource?: string;
  competitorAlternative?: string;
}

export interface TransitionOpportunityStageCommand {
  version: number;
  toStageCode: OpportunityStageCode;
  reason: string;
  stageData?: OpportunityStageData;
  pauseReason?: string;
  reviewAt?: string;
  closeReason?: string;
  closeComment?: string;
  returnAt?: string;
  neverReturn?: boolean;
}

export interface OpportunityStageTransitionResult {
  opportunityId: string;
  processVersion: number;
  fromStageCode: OpportunityStageCode;
  toStageCode: OpportunityStageCode;
  stageLabel: string;
  status: TodayAction["opportunityStatus"];
  stageData: OpportunityStageData;
  version: number;
  occurredAt: string;
}

export const slaWorkingStageCodes = [
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
] as const;

export type SlaWorkingStageCode = (typeof slaWorkingStageCodes)[number];

export interface SlaStageSetting {
  code: SlaWorkingStageCode;
  label: string;
  thresholdDays: number;
}

export interface SlaSettingsPayload {
  processDefinitionId: string;
  version: number;
  publishedAt: string;
  escalationAfterDays: number;
  stages: SlaStageSetting[];
  affectedOpportunities: number;
}

export interface UpdateSlaSettingsCommand {
  version: number;
  escalationAfterDays: number;
  thresholds: Record<SlaWorkingStageCode, number>;
  reason: string;
}

export const opportunityRiskFlags = [
  "overdue",
  "missing-next-action",
  "waiting",
  "technical-risk",
] as const;

export type OpportunityRiskFlag = (typeof opportunityRiskFlags)[number];

export interface FunnelOpportunity {
  id: string;
  version: number;
  processVersion: number;
  organizationId: string;
  organizationName: string;
  domain: string;
  type: string;
  stageCode: OpportunityStageCode;
  stageLabel: string;
  status: TodayAction["opportunityStatus"];
  partnerScore: number;
  owner: {
    id: string;
    name: string;
  };
  nextAction: {
    id: string;
    title: string;
    dueAt: string;
  } | null;
  lastInteractionAt: string | null;
  stageAgeDays: number | null;
  riskFlags: OpportunityRiskFlag[];
}

export interface FunnelStageCount {
  code: OpportunityStageCode;
  label: string;
  count: number;
}

export interface FunnelPayload {
  generatedAt: string;
  teamName: string;
  total: number;
  truncated: boolean;
  processVersions: number[];
  stageCounts: FunnelStageCount[];
  opportunities: FunnelOpportunity[];
}

export const organizationImportFields = [
  "organization_name",
  "domain",
  "segment",
  "owner_email",
  "stage",
  "contact_name",
  "contact_role",
  "contact_email",
  "contact_phone",
  "source",
  "last_interaction_at",
  "next_action",
  "next_action_due_at",
  "notes",
] as const;

export type OrganizationImportField = (typeof organizationImportFields)[number];
export type OrganizationImportDecision = "create" | "update" | "skip" | "conflict";
export type OrganizationImportStatus = "preview" | "committed" | "cancelled";

export type OrganizationImportValues = Record<OrganizationImportField, string>;

export interface OrganizationImportRow {
  rowNo: number;
  values: OrganizationImportValues;
  normalizedDomain: string | null;
  decision: OrganizationImportDecision;
  resolvedDecision: Exclude<OrganizationImportDecision, "conflict"> | null;
  allowedDecisions: Array<Exclude<OrganizationImportDecision, "conflict" | "update">>;
  matchedOrganization: { id: string; name: string } | null;
  fieldErrors: Partial<Record<OrganizationImportField, string>>;
  warnings: string[];
  errorCode: string | null;
  entityId: string | null;
  appliedAt: string | null;
}

export interface OrganizationImportSummary {
  total: number;
  create: number;
  update: number;
  skip: number;
  conflict: number;
  applied: number;
}

export interface OrganizationImportJob {
  id: string;
  fileName: string;
  format: "csv" | "xlsx";
  sourceHash: string;
  status: OrganizationImportStatus;
  summary: OrganizationImportSummary;
  warnings: string[];
  rows: OrganizationImportRow[];
  createdAt: string;
  completedAt: string | null;
}

export interface CommitOrganizationImportCommand {
  resolutions?: Array<{
    rowNo: number;
    decision: "create" | "skip";
  }>;
}

export const radarCandidateStatuses = [
  "new",
  "ready",
  "deferred",
  "rejected",
  "accepted",
  "merged",
] as const;

export type RadarCandidateStatus = (typeof radarCandidateStatuses)[number];
export type RadarEvidenceStatus = "found" | "not_found" | "blocked" | "unknown";
export type RadarConfidence = "high" | "medium" | "low";
export type RadarPriority = "high" | "medium" | "low";

export interface RadarTrafficEstimate {
  provider: string;
  measuredAt: string;
  minMonthlyVisits: number;
  maxMonthlyVisits: number;
  minDailyVisits?: number;
  maxDailyVisits?: number;
  periodStart?: string;
  periodEnd?: string;
  confidence: RadarConfidence;
}

export interface RadarCandidateFeatures {
  topic: string | null;
  language: string | null;
  geography: string | null;
  publicationFrequency: "daily" | "weekly" | "monthly" | "unknown";
  contactsFound: boolean;
  cms: string | null;
  estimatedVideoPagesMin: number | null;
  estimatedVideoPagesMax: number | null;
  trafficEstimate: RadarTrafficEstimate | null;
}

export type RadarResearchField =
  | "topic"
  | "language"
  | "geography"
  | "publicationFrequency"
  | "contactsFound"
  | "cms"
  | "estimatedVideoPages";

export interface RadarFeatureSignal {
  field: RadarResearchField;
  label: string;
  value: string;
  source: string;
  confidence: RadarConfidence;
}

export interface RadarContactLead {
  type: "email" | "phone" | "contact_page" | "telegram";
  value: string;
  href: string;
  sourceUrl: string;
  confidence: RadarConfidence;
  /** Только для Telegram: чей канал — «площадки» (в футере) или «автора» (в статье). */
  kind?: "site" | "author";
}

export interface RadarDecisionMakerLead {
  fullName: string | null;
  role: string;
  department: string | null;
  email: string | null;
  phone: string | null;
  profileUrl: string | null;
  sourceUrl: string;
  evidence: string;
  confidence: RadarConfidence;
}

/**
 * Ближайший доступный канал связи к ЛПР, у которого нет прямых контактов
 * (например, руководитель из ЕГРЮЛ). Подбирается по соответствию отдела/роли
 * и локальной части публичных email организации.
 */
export interface RadarLprChannelLink {
  contactType: "email" | "phone" | "telegram" | "contact_page";
  contactValue: string;
  contactHref: string | null;
  rationale: string;
  confidence: RadarConfidence;
}

export interface RadarVideoPageLead {
  pageUrl: string;
  label: string;
  sourceUrl: string;
  confidence: RadarConfidence;
}

export interface RadarResearchCoverage {
  discoveredUrls: number;
  inspectedUrls: number;
  sitemapUrls: number;
  feedUrls: number;
  videoPagesObserved: number;
  coveragePercent: number;
}

export interface RadarPriorityInsight {
  code: "reach" | "publishing" | "video" | "player" | "contact" | "timing";
  label: string;
  explanation: string;
  confidence: RadarConfidence;
}

export interface RadarOpportunityPotential {
  minDailyVisits: number | null;
  maxDailyVisits: number | null;
  observedVideoSharePercent: number | null;
  minMonthlyVideoOpportunities: number | null;
  maxMonthlyVideoOpportunities: number | null;
  basis: string;
  confidence: RadarConfidence;
}

/** Профиль отправителя первого касания — заполняет менеджер в настройках. */
export interface SenderProfilePayload {
  fullName: string | null;
  email: string | null;
  /** Хэндл без ведущего «@». */
  telegram: string | null;
}

export interface RadarOutreachPackage {
  targetName: string | null;
  targetRole: string;
  channel: "email" | "phone" | "profile" | "contact_page" | "research";
  destination: string | null;
  subject: string;
  messageDraft: string;
  discoveryQuestions: string[];
  nextTask: string;
  /** Подпись текущего менеджера (подставляется при выдаче досье). */
  sender?: SenderProfilePayload | null;
}

export interface RadarChangeSignal {
  code: "new_lpr" | "new_contact" | "traffic_growth" | "video_growth" | "data_refreshed";
  label: string;
  explanation: string;
  detectedAt: string;
  confidence: RadarConfidence;
}

export interface RadarWorkBrief {
  readiness: "ready_for_outreach" | "contact_page_found" | "needs_contact";
  siteSummary: string;
  videoUsage: string;
  rutubeUseCase: string;
  likelyContactRoles: string[];
  risks: string[];
  nextAction: string;
  whyNow?: string;
  priorityInsights?: RadarPriorityInsight[];
  opportunityPotential?: RadarOpportunityPotential;
  outreach?: RadarOutreachPackage;
}

export interface RadarResearch {
  method: "html-signals-v1" | "site-intelligence-v2";
  pageUrl: string;
  collectedAt: string;
  signals: RadarFeatureSignal[];
  contacts: RadarContactLead[];
  decisionMakers: RadarDecisionMakerLead[];
  videoPages: RadarVideoPageLead[];
  brief: RadarWorkBrief;
  notes: string[];
  coverage?: RadarResearchCoverage;
  changeSignals?: RadarChangeSignal[];
  /** ИНН, найденный в реквизитах сайта (страницы контактов/оферты/политики). */
  legalInn?: string | null;
  legalOgrn?: string | null;
  /** Официальная карточка ЕГРЮЛ по найденному ИНН (обогащение ФНС). */
  legalEntity?: RadarLegalEntityCard | null;
  /** Регион юрлица из официального адреса ЕГРЮЛ, например «г. Москва». */
  legalRegion?: string | null;
}

export interface RadarLegalEntityCard {
  inn: string;
  fullName: string | null;
  address: string | null;
  ogrn: string | null;
  /** Регион из адреса регистрации, например «г. Москва» / «Свердловская область». */
  region?: string | null;
  source: "ЕГРЮЛ (ФНС)";
  checkedAt: string;
}

/** How a video player was observed on the page. */
export type RadarPlayerDetectionMethod = "static" | "rendered";

export interface RadarDetectedPlayer {
  /** Stable vendor id from the player signature catalog, e.g. "rutube". */
  vendor: string;
  /** Human-readable vendor name, e.g. "RUTUBE" or "VK Видео". */
  label: string;
  /** True when the vendor is a competing video hosting (not RUTUBE and not a generic self-hosted player). */
  competitor: boolean;
  via: RadarPlayerDetectionMethod;
  sampleUrl?: string | null;
}

export interface RadarEvidence {
  id: string;
  pageUrl: string;
  status: RadarEvidenceStatus;
  playerType: string | null;
  detectedAt: string;
  method: "l0-html" | "manual";
  confidence: RadarConfidence;
  httpStatus: number | null;
  playerFound: boolean;
  embedUrl: string | null;
  errorCode: string | null;
  /** Players recognized by the signature catalog (static HTML and/or headless render). */
  detectedPlayers?: RadarDetectedPlayer[];
  /** Derived: at least one detected player belongs to a competing video hosting. */
  competitorPlayerDetected?: boolean;
}

export interface RadarScoreFactor {
  code: string;
  label: string;
  group: "business" | "content" | "technical" | "contact" | "risk";
  value: number;
  maxValue: number;
  explanation: string;
}

export interface RadarScore {
  total: number;
  automaticTotal: number;
  manualAdjustment: number;
  manualAdjustmentComment: string | null;
  priority: RadarPriority;
  modelVersion: string;
  factors: RadarScoreFactor[];
  calculatedAt: string;
}

/** Structured rejection reasons used to calibrate the Partner Score model. */
export const radarRejectReasonCodes = [
  "no_video_editorial",
  "competitor_exclusive",
  "dead_site",
  "low_traffic",
  "irrelevant_topic",
  "other",
] as const;

export type RadarRejectReasonCode = (typeof radarRejectReasonCodes)[number];

export interface RadarDecision {
  id: string;
  decision: "accept" | "defer" | "reject" | "merge";
  reason: string;
  /** Required for reject, optional for other decisions. */
  reasonCode: RadarRejectReasonCode | null;
  comment: string | null;
  deferUntil: string | null;
  mergeTargetId: string | null;
  /** Partner Score total captured at the moment of the decision. */
  scoreAtDecision: number | null;
  /** Score formula version active at the moment of the decision. */
  formulaVersion: string | null;
  decidedAt: string;
  decidedBy: { id: string; name: string };
}

export interface RadarCandidate {
  id: string;
  name: string;
  source: string;
  inputUrl: string;
  pageUrl: string;
  hostNormalized: string;
  status: RadarCandidateStatus;
  duplicateOrganization: { id: string; name: string } | null;
  duplicateCandidate: { id: string; name: string } | null;
  /**
   * True while an inspection has been requested but has not finished yet.
   * `POST …/checks` returns 202 and the result arrives asynchronously.
   */
  inspectionPending: boolean;
  features: RadarCandidateFeatures;
  research: RadarResearch | null;
  evidence: RadarEvidence[];
  decisions: RadarDecision[];
  score: RadarScore;
  deferUntil: string | null;
  rejectionReason: string | null;
  rejectionComment: string | null;
  mergedIntoCandidateId: string | null;
  acceptedOrganizationId: string | null;
  acceptedOpportunityId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RadarTrafficProviderStatus {
  /** true, когда внешний провайдер трафика настроен через переменные окружения. */
  configured: boolean;
  /** Название провайдера (например, «Similarweb») или null, если не настроен. */
  provider: string | null;
}

export interface RadarPayload {
  generatedAt: string;
  total: number;
  /** Заполняется сервером; отсутствие поля означает старую версию API. */
  trafficProvider?: RadarTrafficProviderStatus;
  candidates: RadarCandidate[];
}

export interface RadarImportResult {
  fileName: string;
  format: "csv" | "xlsx";
  total: number;
  created: number;
  skipped: number;
  failed: number;
  warnings: string[];
  rows: Array<{
    rowNo: number;
    status: "created" | "skipped" | "failed";
    candidateId: string | null;
    hostNormalized: string | null;
    message: string;
  }>;
}

export interface CreateRadarCandidateCommand {
  name: string;
  url: string;
  source: string;
  topic?: string;
  language?: string;
  geography?: string;
  publicationFrequency?: RadarCandidateFeatures["publicationFrequency"];
  contactsFound?: boolean;
  cms?: string;
  estimatedVideoPagesMin?: number;
  estimatedVideoPagesMax?: number;
  trafficEstimate?: RadarTrafficEstimate;
}

export interface RadarCandidateDecisionCommand {
  version: number;
  decision: "accept" | "defer" | "reject" | "merge";
  reason: string;
  /** Structured reason: required for reject, optional otherwise. */
  reasonCode?: RadarRejectReasonCode;
  comment?: string;
  deferUntil?: string;
  mergeTargetId?: string;
}

export interface RadarScoreAdjustmentCommand {
  version: number;
  adjustment: number;
  comment: string;
}

export interface TodaySummary {
  critical: number;
  today: number;
  waiting: number;
  completed: number;
  rescheduled: number;
  stageChanges: number;
  launches: number;
}

export interface TodayPayload {
  generatedAt: string;
  teamName: string;
  currentUser: {
    id: string;
    name: string;
    initials: string;
  };
  summary: TodaySummary;
  actions: TodayAction[];
}

export const weeklyReportMetricKeys = [
  "discovered",
  "qualified",
  "dialogues",
  "integrations",
  "pilots",
  "activeLaunches",
] as const;

export type WeeklyReportMetricKey = (typeof weeklyReportMetricKeys)[number];
export type DataCompleteness = "complete" | "partial" | "unavailable";

export interface GenerateWeeklyReportCommand {
  periodStart: string;
  dataAsOf: string;
  formulaVersion: string;
}

export interface WeeklyReportMetric {
  key: WeeklyReportMetricKey;
  label: string;
  value: number | null;
  previousWeekValue: number | null;
  fourWeekAverage: number | null;
  changeVsPreviousWeek: number | null;
  completeness: DataCompleteness;
}

export interface WeeklyReportStage {
  code: string;
  label: string;
  opportunities: number;
  medianAgeDays: number | null;
}

export interface WeeklyReportException {
  code: "overdue-task" | "missing-next-action" | "stage-stall" | "sla-escalation";
  severity: "high" | "medium";
  organizationId: string;
  organizationName: string;
  opportunityId: string;
  ownerName: string;
  title: string;
  ageDays: number;
}

export interface WeeklyReportDecision {
  code: "resolve-overdue" | "assign-next-action" | "review-stalls";
  question: string;
  owner: string;
  dueAt: string;
  affectedCount: number;
}

export interface WeeklyReportPayload {
  result: WeeklyReportMetric[];
  funnel: {
    activeOpportunities: number;
    stages: WeeklyReportStage[];
    topStalls: WeeklyReportException[];
  };
  execution: {
    nextActionCoverage: {
      covered: number;
      total: number;
      percent: number | null;
    };
    completedTasks: number;
    overdueTasks: number;
    rescheduleReasons: Array<{ reason: string; count: number }>;
    rescheduleDataCompleteness: DataCompleteness;
  };
  network: {
    activePlacements: number | null;
    launchedThisWeek: number | null;
    disabledThisWeek: number | null;
    technicalDegradations: number | null;
    recoveries: number | null;
    completeness: DataCompleteness;
  };
  exceptions: WeeklyReportException[];
  decisions: WeeklyReportDecision[];
  dataQuality: {
    completeness: DataCompleteness;
    availableSources: string[];
    unavailableSources: string[];
    notes: string[];
  };
}

export interface WeeklyReportSnapshot {
  id: string;
  teamId: string;
  teamName: string;
  periodStart: string;
  periodEnd: string;
  dataAsOf: string;
  revision: number;
  formulaVersion: string;
  generatedAt: string;
  generatedBy: {
    id: string;
    name: string;
  };
  payloadUri: string;
  checksum: string;
  payload: WeeklyReportPayload;
}

export type PlacementBusinessStatus = "planned" | "active" | "paused" | "ended";
export type PlacementHealthStatus =
  "unchecked" | "healthy" | "degraded" | "failed" | "awaiting_fix" | "disabled" | "exception";
export type L0CheckResult = "healthy" | "degraded" | "failed" | "blocked" | "unknown";

export interface RegisterPlacementCommand {
  organizationId: string;
  opportunityId: string;
  pageUrl: string;
  urlPattern?: string;
  embedType: "video" | "live" | "playlist";
  environment: "production" | "staging" | "test";
  businessStatus: PlacementBusinessStatus;
  launchedAt?: string;
}

export interface UpdatePlacementCommand {
  version: number;
  reason: string;
  pageUrl?: string;
  urlPattern?: string;
  embedType?: RegisterPlacementCommand["embedType"];
  environment?: RegisterPlacementCommand["environment"];
  businessStatus?: PlacementBusinessStatus;
  launchedAt?: string | null;
}

export interface ArchivePlacementCommand {
  version: number;
  reason: string;
}

export interface HealthCheckView {
  id: string;
  placementId: string;
  checkedAt: string;
  result: L0CheckResult;
  pageHttpStatus: number | null;
  embedHttpStatus: number | null;
  playerFound: boolean;
  embedUrl: string | null;
  evidenceUri: string | null;
  errorCode: string | null;
  durationMs: number;
  source: "manual" | "schedule";
}

export interface PlacementAlertView {
  id: string;
  status: "open" | "closed";
  severity: "high" | "medium";
  firstFailureAt: string;
  openedAt: string;
  closedAt: string | null;
  technicalTaskId: string | null;
}

export interface PlacementView {
  id: string;
  organizationId: string;
  organizationName: string;
  opportunityId: string;
  ownerId: string;
  ownerName: string;
  pageUrl: string;
  urlPattern: string;
  embedType: RegisterPlacementCommand["embedType"];
  environment: RegisterPlacementCommand["environment"];
  businessStatus: PlacementBusinessStatus;
  healthStatus: PlacementHealthStatus;
  launchedAt: string | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  lastSuccessAt: string | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  version: number;
  lastCheck: HealthCheckView | null;
  activeAlert: PlacementAlertView | null;
}

export interface PlacementCheckResult {
  placement: PlacementView;
  check: HealthCheckView;
  alertChange: "none" | "opened" | "closed";
}

export interface TaskNextAction {
  mode: "task";
  title: string;
  dueAt: string;
}

export interface TaskWaitingState {
  mode: "waiting";
  waitingReason: string;
  waitingFor: string;
  reviewAt: string;
}

export interface TaskCloseState {
  mode: "close";
  closeReason: string;
  comment: string;
  returnAt?: string;
  neverReturn?: boolean;
}

export const manualInteractionTypes = ["email", "call", "meeting", "messenger", "note"] as const;

export type ManualInteractionType = (typeof manualInteractionTypes)[number];

export interface CompleteTaskCommand {
  contactId: string;
  interactionType: ManualInteractionType;
  outcome: string;
  summary: string;
  next: TaskNextAction | TaskWaitingState | TaskCloseState;
}

export interface RescheduleTaskCommand {
  dueAt: string;
  reason: string;
}

export const actorRoles = [
  "partner_manager",
  "team_lead",
  "technical_specialist",
  "analyst",
  "legal",
  "admin",
  "observer",
] as const;

export type ActorRole = (typeof actorRoles)[number];

export const actorPermissions = [
  "today.read",
  "tasks.write",
  "partners.read",
  "partners.write",
  "partners.export",
  "partners.export.audit",
  "contacts.view",
  "contacts.write",
  "opportunities.read",
  "opportunities.stage.write",
  "radar.read",
  "radar.write",
  "placements.read",
  "placements.write",
  "reports.view",
  "reports.generate",
  "imports.organizations.write",
  "system.admin",
] as const;

export type ActorPermission = (typeof actorPermissions)[number];

export interface SessionPayload {
  subject: string;
  userId: string;
  displayName: string;
  initials: string;
  email: string | null;
  role: ActorRole;
  permissions: ActorPermission[];
  scope: {
    mode: "own" | "assigned" | "team" | "all";
    teamId: string | null;
    teamName: string | null;
  };
}

export type AccessUserStatus = "active" | "inactive";

export interface AccessUserView {
  id: string;
  subject: string;
  displayName: string;
  email: string;
  teamId: string | null;
  teamName: string | null;
  status: AccessUserStatus;
  role: ActorRole;
  permissions: ActorPermission[];
  version: number;
  updatedAt: string;
  currentUser: boolean;
}

export interface AccessAdministrationPayload {
  users: AccessUserView[];
  teams: Array<{ id: string; name: string }>;
  roles: ActorRole[];
  permissions: ActorPermission[];
  roleDefaults: Record<ActorRole, ActorPermission[]>;
}

export interface CreateAccessUserCommand {
  subject: string;
  displayName: string;
  email: string;
  teamId: string | null;
  role: ActorRole;
  permissions: ActorPermission[];
  reason: string;
}

export interface UpdateAccessUserCommand {
  version: number;
  status: AccessUserStatus;
  role: ActorRole;
  permissions: ActorPermission[];
  reason: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  requestId?: string;
  fieldErrors?: Record<string, string>;
  duplicateCandidates?: ContactCandidate[];
  currentVersion?: number;
}
