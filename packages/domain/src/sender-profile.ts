import type { RadarCandidate, RadarPayload, SenderProfilePayload } from "@embed-os/contracts";

/**
 * Профиль отправителя первого касания. Менеджер заполняет свои имя, email
 * и Telegram в интерфейсе — система подставляет подпись в черновики писем
 * при выдаче досье. Личные данные команды не зашиваются в код или поставку.
 */

export interface SenderProfileInput {
  fullName?: unknown;
  email?: unknown;
  telegram?: unknown;
}

export type SenderProfileParseResult =
  | { ok: true; value: SenderProfilePayload }
  | { ok: false; error: string };

const TELEGRAM_HANDLE_RE = /^[A-Za-z0-9_]{3,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

/** Валидация формы профиля. Пустые строки = «очистить поле». */
export function parseSenderProfileInput(input: unknown): SenderProfileParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Ожидается объект профиля отправителя" };
  }
  const raw = input as SenderProfileInput;
  const fullName = cleanText(raw.fullName, 120);
  const emailRaw = cleanText(raw.email, 254);
  if (emailRaw && !EMAIL_RE.test(emailRaw)) return { ok: false, error: "Некорректный email" };
  let telegram = cleanText(raw.telegram, 64);
  if (telegram) {
    telegram = telegram.replace(/^@/, "");
    if (!TELEGRAM_HANDLE_RE.test(telegram)) {
      return { ok: false, error: "Telegram-хэндл: 3–64 символа, латиница/цифры/подчёркивание" };
    }
  }
  return { ok: true, value: { fullName, email: emailRaw, telegram } };
}

/** Многострочная подпись из заполненных полей («—» + имя + контакты). */
export function formatSenderSignature(profile: SenderProfilePayload | null | undefined): string {
  if (!profile) return "";
  const lines: string[] = [];
  if (profile.fullName) lines.push(`С уважением,\n${profile.fullName}`);
  const contacts: string[] = [];
  if (profile.email) contacts.push(profile.email);
  if (profile.telegram) contacts.push(`@${profile.telegram}`);
  if (contacts.length > 0) lines.push(contacts.join(" · "));
  if (lines.length === 0) return "";
  return `\n\n— ${lines.join("\n")}`;
}

function candidateWithSignature(candidate: RadarCandidate, profile: SenderProfilePayload): RadarCandidate {
  const outreach = candidate.research?.brief?.outreach;
  if (!outreach) return candidate;
  // Подпись идемпотентна: повторная выдача не дублирует блок.
  const signature = formatSenderSignature(profile);
  const draft =
    outreach.sender || outreach.messageDraft.includes(signature.trim())
      ? outreach.messageDraft
      : `${outreach.messageDraft}${signature}`;
  return {
    ...candidate,
    research: candidate.research
      ? {
          ...candidate.research,
          brief: {
            ...candidate.research.brief,
            outreach: { ...outreach, sender: profile, messageDraft: draft },
          },
        }
      : candidate.research,
  };
}

/** Подставляет профиль менеджера во все досье выдачи (без изменения хранения). */
export function withSenderProfile(payload: RadarPayload, profile: SenderProfilePayload): RadarPayload {
  return {
    ...payload,
    candidates: payload.candidates.map((candidate) => candidateWithSignature(candidate, profile)),
  };
}

/** То же для ответа с одним кандидатом (создание/проверка/решение). */
export function singleCandidateWithSenderProfile(
  candidate: RadarCandidate,
  profile: SenderProfilePayload,
): RadarCandidate {
  return candidateWithSignature(candidate, profile);
}
