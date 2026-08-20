import { describe, expect, it } from "vitest";
import { pageFromHash, routablePages } from "./routing";

describe("pageFromHash", () => {
  it("возвращает каждую известную страницу по её hash-пути", () => {
    for (const page of routablePages) {
      expect(pageFromHash(`#/${page}`)).toBe(page);
    }
  });

  it("принимает hash без слэша", () => {
    expect(pageFromHash("#partners")).toBe("partners");
  });

  it("неизвестный путь ведёт на today", () => {
    expect(pageFromHash("#/unknown")).toBe("today");
    expect(pageFromHash("#/PARTNERS")).toBe("today");
    expect(pageFromHash("#/partners/extra")).toBe("today");
  });

  it("пустой hash ведёт на today", () => {
    expect(pageFromHash("")).toBe("today");
    expect(pageFromHash("#")).toBe("today");
    expect(pageFromHash("#/")).toBe("today");
  });
});
