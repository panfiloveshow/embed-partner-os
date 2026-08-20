import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddPlacementDialog, type PlacementContextOption } from "./AddPlacementDialog";

const contexts: PlacementContextOption[] = [
  { organizationId: "org-1", opportunityId: "opp-1", organizationName: "Партнёр Медиа" },
  { organizationId: "org-2", opportunityId: "opp-2", organizationName: "Вторая Организация" },
];

function renderDialog(overrides: Partial<Parameters<typeof AddPlacementDialog>[0]> = {}) {
  const props = {
    contexts,
    busy: false,
    error: null,
    onCancel: vi.fn(),
    onSubmit: vi.fn(async () => {}),
    ...overrides,
  };
  render(<AddPlacementDialog {...props} />);
  return props;
}

describe("AddPlacementDialog", () => {
  it("закрывается по Escape, но не во время запроса", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);

    const busyProps = renderDialog({ busy: true });
    await user.keyboard("{Escape}");
    expect(busyProps.onCancel).not.toHaveBeenCalled();
  });

  it("во время запроса кнопки заблокированы", () => {
    renderDialog({ busy: true });
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Добавляем…" })).toBeDisabled();
  });

  it("показывает ошибку сервера как alert", () => {
    renderDialog({ error: "URL уже зарегистрирован" });
    expect(screen.getByRole("alert")).toHaveTextContent("URL уже зарегистрирован");
  });

  it("без доступных возможностей объясняет причину и блокирует отправку", () => {
    renderDialog({ contexts: [] });
    expect(screen.getByRole("alert")).toHaveTextContent("Нет доступных возможностей");
    expect(screen.getByRole("button", { name: "Добавить размещение" })).toBeDisabled();
  });

  it("отправляет команду с выбранной возможностью и датой запуска", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.selectOptions(screen.getByLabelText("Партнёр и возможность"), "opp-2");
    await user.type(screen.getByLabelText("URL страницы"), "https://partner.ru/articles/video");
    await user.click(screen.getByRole("button", { name: "Добавить размещение" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      organizationId: "org-2",
      opportunityId: "opp-2",
      pageUrl: "https://partner.ru/articles/video",
      embedType: "video",
      environment: "production",
      businessStatus: "active",
      launchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });
});
