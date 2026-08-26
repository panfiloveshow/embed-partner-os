import { describe, expect, it } from "vitest";
import { SenderProfileService } from "./sender-profile.service.js";

describe("SenderProfileService", () => {
  const service = new SenderProfileService();

  it("по умолчанию пустой профиль; апсерт по actorId изолирован", async () => {
    expect(await service.get("user-1")).toEqual({
      fullName: null,
      email: null,
      telegram: null,
    });

    await service.upsert("user-1", {
      fullName: "Анна Соколова",
      email: "a@rutube.ru",
      telegram: "@asokolova",
    });

    expect(await service.get("user-1")).toEqual({
      fullName: "Анна Соколова",
      email: "a@rutube.ru",
      telegram: "asokolova",
    });
    // Другой менеджер не видит чужую подпись.
    expect(await service.get("user-2")).toEqual({
      fullName: null,
      email: null,
      telegram: null,
    });
  });

  it("повторный апсерт перезаписывает, очистка пустыми строками работает", async () => {
    await service.upsert("user-3", { fullName: "Иван Иванов", email: "i@x.ru", telegram: null });
    await service.upsert("user-3", {
      fullName: "",
      email: "new@x.ru",
      telegram: "ivanov",
    });
    expect(await service.get("user-3")).toEqual({
      fullName: null,
      email: "new@x.ru",
      telegram: "ivanov",
    });
  });

  it("невалидный ввод -> BadRequest, профиль не меняется", async () => {
    await service.upsert("user-4", { fullName: "До", email: "", telegram: "" });
    await expect(
      service.upsert("user-4", { fullName: "После", email: "битая-почта", telegram: "" }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await service.get("user-4")).fullName).toBe("До");
  });
});
