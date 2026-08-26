import { useState, type FormEvent } from "react";
import { LoaderCircle, LogIn } from "lucide-react";
import { loginWithPassword } from "../lib/api";
import { messageFor } from "../lib/problem";

interface LocalLoginFormProps {
  /** Вызывается с access-токеном после успешного входа. */
  onAuthenticated: (accessToken: string) => void;
}

/**
 * Форма входа по email/паролю для режима встроенной аутентификации
 * (VITE_AUTH_MODE=*** Показывается вместо корпоративного экрана,
 * когда активной сессии нет или она истекла.
 */
export function LocalLoginForm({ onAuthenticated }: LocalLoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await loginWithPassword(email.trim(), password);
      setPassword("");
      onAuthenticated(session.accessToken);
    } catch (loginError) {
      setError(messageFor(loginError, "Не удалось выполнить вход"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="local-login-form"
      onSubmit={(event) => void submit(event)}
      aria-label="Вход по логину и паролю"
    >
      <label className="field">
        <span>Email</span>
        <input
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span>Пароль</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
      </label>
      {error ? (
        <p role="alert" className="local-login-error">
          {error}
        </p>
      ) : null}
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? (
          <LoaderCircle className="spin" size={17} aria-hidden="true" />
        ) : (
          <LogIn size={17} aria-hidden="true" />
        )}
        Войти
      </button>
    </form>
  );
}
