import type { ApiAccessTokenProvider } from "./api";

export type WebAuthenticationMode = "development" | "external";

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
  if (value === "development" || value === "external") return value;
  throw new Error("VITE_AUTH_MODE должен быть development или external");
}

export function bridgeTokenProvider(bridge: EmbedPartnerAuthBridge): ApiAccessTokenProvider {
  return {
    getAccessToken: ({ forceRefresh }) => bridge.getAccessToken({ forceRefresh }),
  };
}
