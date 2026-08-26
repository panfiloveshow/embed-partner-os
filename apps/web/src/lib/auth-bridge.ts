import type { ApiAccessTokenProvider } from "./api";

export type WebAuthenticationMode = "development" | "external" | "local";

const LOCAL_SESSION_STORAGE_KEY = "embed-os-local-session";

/** Токен локальной сессии из localStorage (null, если недоступен/пуст). */
export function readLocalSessionToken(): string | null {
  try {
    const value = localStorage.getItem(LOCAL_SESSION_STORAGE_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** Сохраняет токен локальной сессии между перезагрузками страницы. */
export function storeLocalSessionToken(token: string): void {
  try {
    localStorage.setItem(LOCAL_SESSION_STORAGE_KEY, token);
  } catch {
    // Приватный режим браузера: сессия просто не переживёт перезагрузку.
  }
}

/** Удаляет сохранённую локальную сессию (выход/истечение). */
export function clearLocalSessionToken(): void {
  try {
    localStorage.removeItem(LOCAL_SESSION_STORAGE_KEY);
  } catch {
    // Нечего удалять — хранилище недоступно.
  }
}

export interface EmbedPartnerAuthBridge {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null> | string | null;
  login?(): Promise<void> | void;
  logout?(): Promise<void> | void;
  subscribe?(listener: () => void): (() => void) | void;
}

declare global {
  interface Window {
    embedPartnerAuth?: EmbedPartnerAuthBridge;
  }
}

export function webAuthenticationMode(
  configured: string | undefined,
  production: boolean,
): WebAuthenticationMode {
  const value = configured?.trim() || (production ? "external" : "development");
  if (value === "development" || value === "external" || value === "local") return value;
  throw new Error("VITE_AUTH_MODE должен быть development, external или local");
}

export function bridgeTokenProvider(bridge: EmbedPartnerAuthBridge): ApiAccessTokenProvider {
  return {
    getAccessToken: ({ forceRefresh }) => bridge.getAccessToken({ forceRefresh }),
  };
}
