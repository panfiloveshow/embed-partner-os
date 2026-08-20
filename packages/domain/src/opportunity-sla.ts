const DAY_MS = 24 * 60 * 60 * 1_000;

export interface OpportunitySlaIncidentState {
  id: string;
  activityMarkerAt: Date;
  ownerNotifiedAt: Date;
  escalatedAt: Date | null;
}

export interface OpportunitySlaInput {
  now: Date;
  status: "ACTIVE" | "WAITING" | "PAUSED" | "CLOSED";
  createdAt: Date;
  lastInteractionAt: Date | null;
  lastStageChangeAt: Date | null;
  thresholdDays: number;
  escalationAfterDays: number;
  activeIncident: OpportunitySlaIncidentState | null;
}

export interface OpportunitySlaEvaluation {
  action: "none" | "open" | "escalate" | "resolve";
  activityMarkerAt: Date;
  violationAgeDays: number;
  thresholdReachedAt: Date;
  escalationDueAt: Date;
}

export function evaluateOpportunitySla(input: OpportunitySlaInput): OpportunitySlaEvaluation {
  validDate(input.now, "SLA clock");
  validDate(input.createdAt, "Opportunity creation time");
  positiveInteger(input.thresholdDays, "SLA threshold");
  positiveInteger(input.escalationAfterDays, "SLA escalation threshold");

  const activityMarkerAt = latestDate(
    input.createdAt,
    input.lastInteractionAt,
    input.lastStageChangeAt,
  );
  const thresholdReachedAt = new Date(activityMarkerAt.getTime() + input.thresholdDays * DAY_MS);
  const violationAgeDays = Math.max(
    0,
    Math.floor((input.now.getTime() - thresholdReachedAt.getTime()) / DAY_MS),
  );
  const escalationDueAt = new Date(
    thresholdReachedAt.getTime() + input.escalationAfterDays * DAY_MS,
  );
  const base = {
    activityMarkerAt,
    violationAgeDays,
    thresholdReachedAt,
    escalationDueAt,
  };

  if (input.status !== "ACTIVE") {
    return { ...base, action: input.activeIncident ? "resolve" : "none" };
  }
  if (
    input.activeIncident &&
    input.activeIncident.activityMarkerAt.getTime() !== activityMarkerAt.getTime()
  ) {
    return { ...base, action: "resolve" };
  }
  if (!input.activeIncident) {
    return {
      ...base,
      action: input.now >= thresholdReachedAt ? "open" : "none",
    };
  }
  const incidentEscalationDueAt = new Date(
    input.activeIncident.ownerNotifiedAt.getTime() + input.escalationAfterDays * DAY_MS,
  );
  return {
    ...base,
    escalationDueAt: incidentEscalationDueAt,
    action:
      input.activeIncident.escalatedAt === null && input.now >= incidentEscalationDueAt
        ? "escalate"
        : "none",
  };
}

function latestDate(first: Date, ...values: Array<Date | null>) {
  return values.reduce<Date>((latest, value) => (value && value > latest ? value : latest), first);
}

function validDate(value: Date, label: string) {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${label} is invalid`);
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new RangeError(`${label} must be an integer between 1 and 365 days`);
  }
}
