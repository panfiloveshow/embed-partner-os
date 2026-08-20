import type { PriorityReason } from "@embed-os/contracts";

export interface PriorityFactors {
  overdueBusinessDays?: number;
  partnerScore?: number;
  hasInboundResponse?: boolean;
  isIntegrationOrPilot?: boolean;
  hasCriticalTechnicalAlert?: boolean;
  inactiveDays?: number;
  isWaitingBeforeReview?: boolean;
}

export interface PriorityResult {
  score: number;
  reasons: PriorityReason[];
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function calculatePriority(input: PriorityFactors): PriorityResult {
  let score = 0;
  const weightedReasons: Array<PriorityReason & { weight: number }> = [];
  const overdueDays = Math.max(0, input.overdueBusinessDays ?? 0);

  if (overdueDays > 0) {
    const weight = overdueDays > 3 ? 40 : 25;
    score += weight;
    weightedReasons.push({
      code: "overdue",
      label: `Просрочка ${overdueDays} ${businessDayWord(overdueDays)}`,
      weight,
    });
  }

  if (input.hasInboundResponse) {
    score += 20;
    weightedReasons.push({ code: "inbound", label: "Ответ партнёра", weight: 20 });
  }

  const partnerContribution = Math.round(clamp(input.partnerScore ?? 0, 0, 100) * 0.2);
  if (partnerContribution > 0) {
    score += partnerContribution;
    weightedReasons.push({
      code: "partner-potential",
      label: "Высокий потенциал",
      weight: partnerContribution,
    });
  }

  if (input.isIntegrationOrPilot || input.hasCriticalTechnicalAlert) {
    score += 15;
    weightedReasons.push({
      code: "technical-risk",
      label: input.hasCriticalTechnicalAlert ? "Технический риск" : "Критичная стадия",
      weight: 15,
    });
  }

  const inactivityContribution = clamp(Math.floor((input.inactiveDays ?? 0) / 3), 0, 10);
  if (inactivityContribution > 0) {
    score += inactivityContribution;
    weightedReasons.push({
      code: "inactivity",
      label: "Давно не было активности",
      weight: inactivityContribution,
    });
  }

  if (input.isWaitingBeforeReview) {
    score -= 20;
    weightedReasons.push({
      code: "waiting",
      label: "Ожидание партнёра",
      weight: -20,
    });
  }

  return {
    score: clamp(score, 0, 100),
    reasons: weightedReasons
      .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight))
      .slice(0, 3)
      .map(({ weight: _weight, ...reason }) => reason),
  };
}

function businessDayWord(value: number) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

