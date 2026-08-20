import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthenticationBoundary } from "./components/AuthenticationBoundary";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthenticationBoundary>{({ logout }) => <App onLogout={logout} />}</AuthenticationBoundary>
    </ErrorBoundary>
  </StrictMode>,
);
