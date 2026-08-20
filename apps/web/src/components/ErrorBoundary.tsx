import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Необработанная ошибка интерфейса", error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="center-state" role="alert">
          <TriangleAlert size={30} aria-hidden="true" />
          <h1>Что-то пошло не так</h1>
          <p>Раздел не отобразился из-за непредвиденной ошибки. Перезагрузите страницу.</p>
          <button
            className="button button-primary"
            type="button"
            onClick={() => window.location.reload()}
          >
            Перезагрузить
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
