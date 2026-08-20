import type {
  ArchivePlacementCommand,
  CompleteTaskCommand,
  ContactOption,
  ContactRegistryItem,
  ContactRegistryPayload,
  ChangeContactStatusCommand,
  FunnelPayload,
  CreateContactCommand,
  LinkContactCommand,
  MergeContactCommand,
  MergeContactResult,
  UpdateContactCommand,
  CommitOrganizationImportCommand,
  OrganizationImportJob,
  ProblemDetails,
  TodayPayload,
  GenerateWeeklyReportCommand,
  HealthCheckView,
  PlacementCheckResult,
  PlacementView,
  RegisterPlacementCommand,
  UpdatePlacementCommand,
  OpportunityStageTransitionResult,
  PartnerCardPayload,
  PartnerIntegrationStatus,
  PartnerRegistryPayload,
  CreateRadarCandidateCommand,
  RadarCandidate,
  RadarCandidateDecisionCommand,
  RadarPayload,
  RadarImportResult,
  RadarScoreAdjustmentCommand,
  TransitionOpportunityStageCommand,
  WeeklyReportSnapshot,
  RescheduleTaskCommand,
  SessionPayload,
  SlaSettingsPayload,
  UpdateSlaSettingsCommand,
  AccessAdministrationPayload,
  AccessUserView,
  CreateAccessUserCommand,
  UpdateAccessUserCommand,
} from "@embed-os/contracts";

const apiBase = import.meta.env.VITE_API_URL ?? "/api/v1";
let apiAccessToken: string | null = null;
let apiAccessTokenProvider: ApiAccessTokenProvider | null = null;
let inFlightAccessToken: {
  forceRefresh: boolean;
  promise: Promise<string | null>;
} | null = null;
const authenticationRequiredListeners = new Set<(problem: ProblemDetails) => void>();

export interface ApiAccessTokenProvider {
  getAccessToken(options: { forceRefresh: boolean }): Promise<string | null> | string | null;
}

export function configureApiAccessToken(token: string | null) {
  if (token !== null && (!token.trim() || token.length > 16_384 || /\s/.test(token))) {
    throw new TypeError("OIDC access token имеет недопустимый формат");
  }
  apiAccessToken = token;
}

export function configureApiAccessTokenProvider(provider: ApiAccessTokenProvider | null) {
  apiAccessTokenProvider = provider;
  inFlightAccessToken = null;
  if (!provider) configureApiAccessToken(null);
}

export function subscribeApiAuthenticationRequired(listener: (problem: ProblemDetails) => void) {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

export interface PartnerRegistryFilters {
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

export interface PartnerExportDownload {
  blob: Blob;
  fileName: string;
  auditId: string;
}

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail);
    this.name = "ApiError";
  }
}

export async function fetchToday(signal?: AbortSignal): Promise<TodayPayload> {
  return request<TodayPayload>("/today", { signal });
}

export async function fetchSession(signal?: AbortSignal): Promise<SessionPayload> {
  return request<SessionPayload>("/session", { signal });
}

export async function fetchAccessAdministration(
  signal?: AbortSignal,
): Promise<AccessAdministrationPayload> {
  return request<AccessAdministrationPayload>("/settings/access/users", { signal });
}

export async function updateAccessUser(
  userId: string,
  command: UpdateAccessUserCommand,
  idempotencyKey: string,
): Promise<AccessUserView> {
  return request<AccessUserView>(`/settings/access/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function createAccessUser(
  command: CreateAccessUserCommand,
  idempotencyKey: string,
): Promise<AccessUserView> {
  return request<AccessUserView>("/settings/access/users", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function fetchFunnel(signal?: AbortSignal): Promise<FunnelPayload> {
  return request<FunnelPayload>("/opportunities", { signal });
}

export async function fetchContactRegistry(
  filters: {
    search?: string;
    status?: string;
    organizationId?: string;
    duplicatesOnly?: boolean;
  } = {},
  signal?: AbortSignal,
): Promise<ContactRegistryPayload> {
  const query = new URLSearchParams();
  if (filters.search) query.set("search", filters.search);
  if (filters.status && filters.status !== "all") query.set("status", filters.status);
  if (filters.organizationId) query.set("organizationId", filters.organizationId);
  if (filters.duplicatesOnly) query.set("duplicatesOnly", "true");
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return request<ContactRegistryPayload>(`/contacts${suffix}`, { signal });
}

export async function fetchPartnerRegistry(
  filters: PartnerRegistryFilters = {},
  signal?: AbortSignal,
): Promise<PartnerRegistryPayload> {
  const query = new URLSearchParams();
  if (filters.search) query.set("search", filters.search);
  if (filters.groupId) query.set("groupId", filters.groupId);
  if (filters.segment) query.set("segment", filters.segment);
  if (filters.ownerId) query.set("ownerId", filters.ownerId);
  if (filters.stageCode) query.set("stageCode", filters.stageCode);
  if (filters.scoreMin !== undefined) query.set("scoreMin", String(filters.scoreMin));
  if (filters.scoreMax !== undefined) query.set("scoreMax", String(filters.scoreMax));
  if (filters.integrationStatus) query.set("integrationStatus", filters.integrationStatus);
  if (filters.activeAfter) query.set("activeAfter", filters.activeAfter);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return request<PartnerRegistryPayload>(`/partners${suffix}`, { signal });
}

export async function exportPartnerRegistry(
  filters: PartnerRegistryFilters = {},
): Promise<PartnerExportDownload> {
  const response = await authenticatedFetch(`${apiBase}/partners/exports`, {
    method: "POST",
    headers: withAuthorization({
      "content-type": "application/json",
    }),
    body: JSON.stringify(filters),
  });
  if (!response.ok) {
    const problem = (await response.json()) as ProblemDetails;
    throw new ApiError(problem);
  }
  return {
    blob: await response.blob(),
    fileName: exportFileName(response.headers.get("content-disposition")),
    auditId: response.headers.get("x-export-audit-id") ?? "",
  };
}

export async function fetchPartnerCard(
  organizationId: string,
  signal?: AbortSignal,
): Promise<PartnerCardPayload> {
  return request<PartnerCardPayload>(`/partners/${encodeURIComponent(organizationId)}`, { signal });
}

export async function fetchRadar(signal?: AbortSignal): Promise<RadarPayload> {
  return request<RadarPayload>("/radar/candidates", { signal });
}

export async function createRadarCandidate(
  command: CreateRadarCandidateCommand,
  idempotencyKey: string,
): Promise<RadarCandidate> {
  return request<RadarCandidate>("/radar/candidates", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function importRadarCandidates(
  file: File,
  idempotencyKey: string,
): Promise<RadarImportResult> {
  const body = new FormData();
  body.append("file", file);
  return request<RadarImportResult>("/radar/candidates/import", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body,
  });
}

export async function inspectRadarCandidate(
  candidateId: string,
  idempotencyKey: string,
): Promise<RadarCandidate> {
  return request<RadarCandidate>(`/radar/candidates/${encodeURIComponent(candidateId)}/checks`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
}

export async function decideRadarCandidate(
  candidateId: string,
  command: RadarCandidateDecisionCommand,
  idempotencyKey: string,
): Promise<RadarCandidate> {
  return request<RadarCandidate>(`/radar/candidates/${encodeURIComponent(candidateId)}/decisions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function adjustRadarCandidateScore(
  candidateId: string,
  command: RadarScoreAdjustmentCommand,
  idempotencyKey: string,
): Promise<RadarCandidate> {
  return request<RadarCandidate>(
    `/radar/candidates/${encodeURIComponent(candidateId)}/score-adjustments`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(command),
    },
  );
}

export async function previewOrganizationImport(file: File): Promise<OrganizationImportJob> {
  const body = new FormData();
  body.append("file", file);
  return request<OrganizationImportJob>("/imports/organizations/preview", {
    method: "POST",
    body,
  });
}

export async function commitOrganizationImport(
  jobId: string,
  command: CommitOrganizationImportCommand,
  idempotencyKey: string,
): Promise<OrganizationImportJob> {
  return request<OrganizationImportJob>(
    `/imports/organizations/${encodeURIComponent(jobId)}/commit`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(command),
    },
  );
}

export async function cancelOrganizationImport(
  jobId: string,
  idempotencyKey: string,
): Promise<OrganizationImportJob> {
  return request<OrganizationImportJob>(
    `/imports/organizations/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
    },
  );
}

export async function fetchLatestWeeklyReport(signal?: AbortSignal): Promise<WeeklyReportSnapshot> {
  return request<WeeklyReportSnapshot>("/reports/weekly/snapshots/latest", { signal });
}

export async function generateWeeklyReport(
  command: GenerateWeeklyReportCommand,
  idempotencyKey: string,
): Promise<WeeklyReportSnapshot> {
  return request<WeeklyReportSnapshot>("/reports/weekly/snapshots", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function fetchSlaSettings(signal?: AbortSignal): Promise<SlaSettingsPayload> {
  return request<SlaSettingsPayload>("/settings/sla", { signal });
}

export async function updateSlaSettings(
  command: UpdateSlaSettingsCommand,
  idempotencyKey: string,
): Promise<SlaSettingsPayload> {
  return request<SlaSettingsPayload>("/settings/sla", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function fetchPlacements(signal?: AbortSignal): Promise<PlacementView[]> {
  return request<PlacementView[]>("/placements", { signal });
}

export async function fetchPlacementChecks(
  placementId: string,
  signal?: AbortSignal,
): Promise<HealthCheckView[]> {
  return request<HealthCheckView[]>(`/placements/${encodeURIComponent(placementId)}/checks`, {
    signal,
  });
}

export async function runPlacementL0Check(
  placementId: string,
  idempotencyKey: string,
): Promise<PlacementCheckResult> {
  return request<PlacementCheckResult>(`/placements/${encodeURIComponent(placementId)}/l0-checks`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
}

export async function registerPlacement(
  command: RegisterPlacementCommand,
  idempotencyKey: string,
): Promise<PlacementView> {
  return request<PlacementView>("/placements", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function updatePlacement(
  placementId: string,
  command: UpdatePlacementCommand,
  idempotencyKey: string,
): Promise<PlacementView> {
  return request<PlacementView>(`/placements/${encodeURIComponent(placementId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function archivePlacement(
  placementId: string,
  command: ArchivePlacementCommand,
  idempotencyKey: string,
): Promise<PlacementView> {
  return request<PlacementView>(`/placements/${encodeURIComponent(placementId)}/archive`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function transitionOpportunityStage(
  opportunityId: string,
  command: TransitionOpportunityStageCommand,
  idempotencyKey: string,
): Promise<OpportunityStageTransitionResult> {
  return request<OpportunityStageTransitionResult>(
    `/opportunities/${encodeURIComponent(opportunityId)}/stage-transitions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(command),
    },
  );
}

export async function completeTask(
  taskId: string,
  command: CompleteTaskCommand,
  idempotencyKey: string,
): Promise<TodayPayload> {
  return request<TodayPayload>(`/tasks/${encodeURIComponent(taskId)}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function rescheduleTask(
  taskId: string,
  command: RescheduleTaskCommand,
  idempotencyKey: string,
): Promise<TodayPayload> {
  return request<TodayPayload>(`/tasks/${encodeURIComponent(taskId)}/reschedule`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function createContact(
  organizationId: string,
  command: CreateContactCommand,
  idempotencyKey: string,
): Promise<ContactOption> {
  return request<ContactOption>(`/organizations/${encodeURIComponent(organizationId)}/contacts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function linkContact(
  organizationId: string,
  contactId: string,
  command: LinkContactCommand,
  idempotencyKey: string,
): Promise<ContactOption> {
  return request<ContactOption>(
    `/organizations/${encodeURIComponent(organizationId)}/contacts/${encodeURIComponent(contactId)}/link`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(command),
    },
  );
}

export async function mergeContact(
  sourceContactId: string,
  command: MergeContactCommand,
  idempotencyKey: string,
): Promise<MergeContactResult> {
  return request<MergeContactResult>(`/contacts/${encodeURIComponent(sourceContactId)}/merge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function updateContactRecord(
  contactId: string,
  command: UpdateContactCommand,
  idempotencyKey: string,
): Promise<ContactRegistryItem> {
  return request<ContactRegistryItem>(`/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

export async function archiveContactRecord(
  contactId: string,
  command: ChangeContactStatusCommand,
  idempotencyKey: string,
): Promise<ContactRegistryItem> {
  return changeContactStatus(contactId, "archive", command, idempotencyKey);
}

export async function restoreContactRecord(
  contactId: string,
  command: ChangeContactStatusCommand,
  idempotencyKey: string,
): Promise<ContactRegistryItem> {
  return changeContactStatus(contactId, "restore", command, idempotencyKey);
}

function changeContactStatus(
  contactId: string,
  action: "archive" | "restore",
  command: ChangeContactStatusCommand,
  idempotencyKey: string,
) {
  return request<ContactRegistryItem>(`/contacts/${encodeURIComponent(contactId)}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(command),
  });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`${apiBase}${path}`, init);
  if (!response.ok) {
    const problem = await readProblem(response);
    throw new ApiError(problem);
  }
  return (await response.json()) as T;
}

async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit) {
  const firstToken = await resolveApiAccessToken(false);
  let response = await fetchWithToken(input, init, firstToken);
  if (response.status === 401 && apiAccessTokenProvider) {
    const refreshedToken = await resolveApiAccessToken(true);
    if (refreshedToken) response = await fetchWithToken(input, init, refreshedToken);
  }
  if (response.status === 401) {
    const problem = await readProblem(response);
    authenticationRequiredListeners.forEach((listener) => listener(problem));
    return problemResponse(problem, response);
  }
  return response;
}

async function resolveApiAccessToken(forceRefresh: boolean) {
  if (!apiAccessTokenProvider) return apiAccessToken;
  if (inFlightAccessToken && (!forceRefresh || inFlightAccessToken.forceRefresh)) {
    return inFlightAccessToken.promise;
  }
  const provider = apiAccessTokenProvider;
  const promise = Promise.resolve(provider.getAccessToken({ forceRefresh })).then((token) => {
    if (apiAccessTokenProvider === provider) configureApiAccessToken(token);
    return token;
  });
  const pending = { forceRefresh, promise };
  inFlightAccessToken = pending;
  try {
    return await promise;
  } finally {
    if (inFlightAccessToken === pending) inFlightAccessToken = null;
  }
}

function fetchWithToken(input: RequestInfo | URL, init: RequestInit, token: string | null) {
  return fetch(input, token ? { ...init, headers: withAuthorization(init.headers) } : init);
}

async function readProblem(response: Response): Promise<ProblemDetails> {
  try {
    return (await response.clone().json()) as ProblemDetails;
  } catch {
    return {
      type: "about:blank",
      title: "Запрос отклонён",
      status: response.status,
      detail:
        response.status === 401
          ? "Корпоративная сессия отсутствует или истекла"
          : "Сервер вернул некорректный ответ",
      code: response.status === 401 ? "AUTHENTICATION_REQUIRED" : "INVALID_ERROR_RESPONSE",
    };
  }
}

function problemResponse(problem: ProblemDetails, response: Response) {
  return new Response(JSON.stringify(problem), {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "application/problem+json" },
  });
}

function withAuthorization(headers?: HeadersInit) {
  const authenticated = new Headers(headers);
  if (apiAccessToken) authenticated.set("authorization", `Bearer ${apiAccessToken}`);
  return Object.fromEntries(authenticated.entries());
}

function exportFileName(contentDisposition: string | null) {
  const encoded = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return safeExportFileName(decodeURIComponent(encoded));
    } catch {
      // Fall through to the plain filename or the deterministic default.
    }
  }
  const plain = contentDisposition?.match(/filename="?([^";]+)"?/i)?.[1];
  return safeExportFileName(plain ?? "rutube-partners.csv");
}

function safeExportFileName(value: string) {
  const sanitized = value.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  return sanitized && sanitized.toLocaleLowerCase().endsWith(".csv")
    ? sanitized
    : "rutube-partners.csv";
}
