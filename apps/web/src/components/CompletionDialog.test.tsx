import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompletionDialog } from "./CompletionDialog";
import { makeContact, makeTodayAction } from "../test/fixtures";

function renderDialog(overrides: Partial<Parameters<typeof CompletionDialog>[0]> = {}) {
  const props = {
    task: makeTodayAction(),
    busy: false,
    error: null,
    onCancel: vi.fn(),
    onSubmit: vi.fn(async () => {}),
    ...overrides,
  };
  render(<CompletionDialog {...props} />);
  return props;
}

describe("CompletionDialog", () => {
  it("закрывается по Escape", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("во время сохранения Escape и кнопки заблокированы", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ busy: true });
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Сохраняем…" })).toBeDisabled();
  });

  it("показывает ошибку сервера как alert", () => {
    renderDialog({ error: "Возможность уже закрыта" });
    expect(screen.getByRole("alert")).toHaveTextContent("Возможность уже закрыта");
  });

  it("отправляет команду с основным контактом и следующим шагом", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      task: makeTodayAction({
        contacts: [
          makeContact({ id: "contact-2", fullName: "Пётр Иванов", isPrimary: false }),
          makeContact({ id: "contact-1", isPrimary: true }),
        ],
      }),
    });
    await user.type(screen.getByLabelText("Краткое резюме"), "Обсудили условия");
    await user.type(screen.getByLabelText("Действие"), "Прислать договор");
    await user.click(screen.getByRole("button", { name: "Сохранить результат и шаг" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "contact-1",
        interactionType: "email",
        outcome: "Контакт состоялся",
        summary: "Обсудили условия",
        next: expect.objectContaining({ mode: "task", title: "Прислать договор" }),
      }),
    );
  });

  it("без действующих контактов отправка недоступна", () => {
    renderDialog({ task: makeTodayAction({ contacts: [] }) });
    expect(screen.getByRole("button", { name: "Сохранить результат и шаг" })).toBeDisabled();
  });
});
