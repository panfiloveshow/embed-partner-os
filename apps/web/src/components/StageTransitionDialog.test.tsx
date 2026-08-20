import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StageTransitionDialog } from "./StageTransitionDialog";
import { makeTodayAction } from "../test/fixtures";

function renderDialog(overrides: Partial<Parameters<typeof StageTransitionDialog>[0]> = {}) {
  const props = {
    task: makeTodayAction({ stageCode: "S5", stageLabel: "Предложение" }),
    busy: false,
    error: null,
    onCancel: vi.fn(),
    onSubmit: vi.fn(async () => {}),
    ...overrides,
  };
  render(<StageTransitionDialog {...props} />);
  return props;
}

describe("StageTransitionDialog", () => {
  it("предлагает следующую стадию, паузу и закрытие для рабочей стадии", () => {
    renderDialog();
    const options = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(["S6", "SX", "SL"]);
  });

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
    expect(screen.getByRole("button", { name: "Проверяем…" })).toBeDisabled();
  });

  it("показывает ошибку сервера как alert", () => {
    renderDialog({ error: "Стадия недоступна" });
    expect(screen.getByRole("alert")).toHaveTextContent("Стадия недоступна");
  });

  it("обычный переход отправляет только версию, стадию и обоснование", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.type(screen.getByLabelText("Обоснование перехода"), "Условия согласованы");
    await user.click(screen.getByRole("button", { name: "Выполнить переход" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      version: 3,
      toStageCode: "S6",
      reason: "Условия согласованы",
    });
  });

  it("переход в паузу (SX) добавляет причину и дату возврата", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.selectOptions(screen.getByLabelText("Новая стадия"), "SX");
    await user.type(screen.getByLabelText("Обоснование перехода"), "Партнёр взял паузу");
    await user.type(screen.getByLabelText("Причина паузы"), "Бюджет заморожен до осени");
    await user.click(screen.getByRole("button", { name: "Выполнить переход" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      version: 3,
      toStageCode: "SX",
      reason: "Партнёр взял паузу",
      pauseReason: "Бюджет заморожен до осени",
      reviewAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  it("закрытие (SL) с флагом «не возвращаться» отправляет neverReturn без даты возврата", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.selectOptions(screen.getByLabelText("Новая стадия"), "SL");
    await user.type(screen.getByLabelText("Обоснование перехода"), "Отказ партнёра");
    await user.selectOptions(screen.getByLabelText("Причина закрытия"), "Нет ответа");
    await user.type(screen.getByLabelText("Комментарий"), "Три касания без реакции");
    await user.click(screen.getByLabelText("Не возвращаться к этой возможности"));
    await user.click(screen.getByRole("button", { name: "Выполнить переход" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      version: 3,
      toStageCode: "SL",
      reason: "Отказ партнёра",
      closeReason: "Нет ответа",
      closeComment: "Три касания без реакции",
      neverReturn: true,
    });
  });

  it("закрытие (SL) без флага отправляет допустимую дату возврата", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    await user.selectOptions(screen.getByLabelText("Новая стадия"), "SL");
    await user.type(screen.getByLabelText("Обоснование перехода"), "Отказ партнёра");
    await user.selectOptions(
      screen.getByLabelText("Причина закрытия"),
      "Нет приоритета у партнёра",
    );
    await user.type(screen.getByLabelText("Комментарий"), "Вернёмся в следующем квартале");
    await user.click(screen.getByRole("button", { name: "Выполнить переход" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ returnAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) }),
    );
    expect(onSubmit).not.toHaveBeenCalledWith(expect.objectContaining({ neverReturn: true }));
  });
});
