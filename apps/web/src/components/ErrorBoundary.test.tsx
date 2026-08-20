import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("render failure");
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("показывает fallback с кнопкой перезагрузки вместо падения приложения", () => {
    // React и сам boundary логируют пойманную ошибку — не засоряем вывод теста.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Что-то пошло не так");
    expect(screen.getByRole("button", { name: "Перезагрузить" })).toBeInTheDocument();
  });

  it("рендерит потомков, пока ошибки нет", () => {
    render(
      <ErrorBoundary>
        <p>Рабочий раздел</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Рабочий раздел")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
