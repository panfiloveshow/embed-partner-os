import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LogIn, RefreshCw, ShieldAlert } from "lucide-react";
import {
  configureApiAccessToken,
  configureApiAccessTokenProvider,
  subscribeApiAuthenticationRequired,
} from "../lib/api";
import {
  bridgeTokenProvider,
  clearLocalSessionToken,
  readLocalSessionToken,
  storeLocalSessionToken,
  webAuthenticationMode,
  type EmbedPartnerAuthBridge,
  type WebAuthenticationMode,
} from "../lib/auth-bridge";
import { LocalLoginForm } from "./LocalLoginForm";

type AuthenticationState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "required"; message: string }
  | { status: "misconfigured"; message: string };

interface AuthenticationBoundaryProps {
  children: (session: { logout?: () => Promise<void> }) => ReactNode;
}

export function AuthenticationBoundary({ children }: AuthenticationBoundaryProps) {
  const [state, setState] = useState<AuthenticationState>({ status: "checking" });
  const [bridge, setBridge] = useState<EmbedPartnerAuthBridge | null>(null);
  const [mode, setMode] = useState<WebAuthenticationMode | null>(null);

  const synchronize = useCallback(async (currentBridge: EmbedPartnerAuthBridge) => {
    setState({ status: "checking" });
    try {
      const token = await currentBridge.getAccessToken({ forceRefresh: false });
      configureApiAccessToken(token);
      setState(
        token
          ? { status: "ready" }
          : { status: "required", message: "Войдите через корпоративную учётную запись" },
      );
    } catch {
      configureApiAccessToken(null);
      setState({
        status: "required",
        message: "Не удалось получить корпоративную сессию",
      });
    }
  }, []);

  useEffect(() => {
    let mode;
    try {
      mode = webAuthenticationMode(import.meta.env.VITE_AUTH_MODE, import.meta.env.PROD);
    } catch (error) {
      setState({
        status: "misconfigured",
        message: error instanceof Error ? error.message : "Некорректная конфигурация входа",
      });
      return;
    }

    setMode(mode);

    if (mode === "local") {
      configureApiAccessTokenProvider(null);
      const stored = readLocalSessionToken();
      configureApiAccessToken(stored);
      setState(
        stored
          ? { status: "ready" }
          : { status: "required", message: "Войдите по логину и паролю" },
      );
      const unsubscribeExpired = subscribeApiAuthenticationRequired(() => {
        clearLocalSessionToken();
        configureApiAccessToken(null);
        setState({
          status: "required",
          message: "Сессия истекла. Войдите заново",
        });
      });
      return () => {
        unsubscribeExpired();
        configureApiAccessTokenProvider(null);
      };
    }

    if (mode === "development") {
      configureApiAccessTokenProvider(null);
      setState({ status: "ready" });
      return;
    }

    const currentBridge = window.embedPartnerAuth;
    if (!currentBridge) {
      setState({
        status: "misconfigured",
        message: "Корпоративная оболочка не передала window.embedPartnerAuth",
      });
      return;
    }

    setBridge(currentBridge);
    configureApiAccessTokenProvider(bridgeTokenProvider(currentBridge));
    const unsubscribeRequired = subscribeApiAuthenticationRequired(() => {
      configureApiAccessToken(null);
      setState({
        status: "required",
        message: "Сессия истекла или была отозвана. Войдите повторно",
      });
    });
    const unsubscribeBridge = currentBridge.subscribe?.(() => {
      void synchronize(currentBridge);
    });
    void synchronize(currentBridge);

    return () => {
      unsubscribeRequired();
      unsubscribeBridge?.();
      configureApiAccessTokenProvider(null);
    };
  }, [synchronize]);

  const login = useCallback(async () => {
    if (!bridge?.login) {
      setState({
        status: "misconfigured",
        message: "Корпоративный провайдер не реализовал метод login()",
      });
      return;
    }
    setState({ status: "checking" });
    try {
      await bridge.login();
      await synchronize(bridge);
    } catch {
      setState({ status: "required", message: "Корпоративный вход не завершён" });
    }
  }, [bridge, synchronize]);

  const logout = useCallback(async () => {
    configureApiAccessToken(null);
    try {
      await bridge?.logout?.();
    } finally {
      if (mode === "local") {
        clearLocalSessionToken();
        setState({ status: "required", message: "Вы вышли из сессии" });
      } else {
        setState({ status: "required", message: "Вы вышли из корпоративной сессии" });
      }
    }
  }, [bridge, mode]);

  if (state.status === "ready") {
    return <>{children(bridge || mode === "local" ? { logout } : {})}</>;
  }

  if (state.status === "checking") {
    return (
      <main className="center-state" aria-live="polite">
        <span className="loader" aria-hidden="true" />
        <p>Проверяем корпоративную сессию…</p>
      </main>
    );
  }

  const canLogin = state.status === "required" && Boolean(bridge?.login);
  return (
    <main className="center-state auth-state" aria-live="polite">
      {state.status === "misconfigured" ? (
        <ShieldAlert size={34} aria-hidden="true" />
      ) : (
        <LogIn size={34} aria-hidden="true" />
      )}
      <h1>
        {state.status === "misconfigured"
          ? "Вход не настроен"
          : mode === "local"
            ? "Вход в систему"
            : "Нужен корпоративный вход"}
      </h1>
      <p>{state.message}</p>
      {state.status === "required" && mode === "local" ? (
        <LocalLoginForm
          onAuthenticated={(token) => {
            storeLocalSessionToken(token);
            configureApiAccessToken(token);
            setState({ status: "ready" });
          }}
        />
      ) : canLogin ? (
        <button className="button button-primary" type="button" onClick={() => void login()}>
          <LogIn size={17} aria-hidden="true" />
          Войти
        </button>
      ) : state.status === "required" ? (
        <button className="button" type="button" onClick={() => bridge && void synchronize(bridge)}>
          <RefreshCw size={17} aria-hidden="true" />
          Проверить снова
        </button>
      ) : null}
    </main>
  );
}
