import { describe, expect, it } from "vitest";
import {
  classifyOrganizationImportRows,
  parseOrganizationImportFile,
} from "./organization-import.js";

describe("organization import", () => {
  it("parses quoted CSV, normalizes domains and classifies every row", async () => {
    const parsed = await parseOrganizationImportFile({
      fileName: "partners.csv",
      buffer: Buffer.from([
        "organization_name,domain,segment,source,notes",
        '"Новый медиа, ООО",https://www.new-media.ru/video,Новости,Пилот,"важный, партнёр"',
        "Медиа Новости,www.medianovosti.ru,Медиа,Таблица,Обновить сегмент",
        "Медиа Новости,another-domain.ru,Медиа,Таблица,Проверить дубль",
        "Битая строка,,Медиа,Таблица,",
      ].join("\n"), "utf8"),
    });

    const rows = classifyOrganizationImportRows(parsed.rows, [
      { id: "org-1", name: "Медиа Новости", domain: "medianovosti.ru", segment: "Старый" },
    ]);

    expect(parsed.format).toBe("csv");
    expect(rows.map(({ decision }) => decision)).toEqual([
      "create",
      "update",
      "conflict",
      "conflict",
    ]);
    expect(rows[0]).toMatchObject({
      rowNo: 2,
      normalizedDomain: "new-media.ru",
      values: { organization_name: "Новый медиа, ООО", notes: "важный, партнёр" },
    });
    expect(rows[2]).toMatchObject({
      errorCode: "AMBIGUOUS_NAME_MATCH",
      allowedDecisions: ["create", "skip"],
    });
    expect(rows[3].fieldErrors).toEqual({ domain: "Укажите домен" });
  });

  it("marks a repeated domain inside one file as a non-creatable conflict", async () => {
    const parsed = await parseOrganizationImportFile({
      fileName: "partners.csv",
      buffer: Buffer.from([
        "organization_name;domain;source",
        "Первый;example.ru;Таблица",
        "Второй;www.example.ru;Таблица",
      ].join("\n"), "utf8"),
    });

    const rows = classifyOrganizationImportRows(parsed.rows, []);

    expect(rows[1]).toMatchObject({
      decision: "conflict",
      errorCode: "DUPLICATE_DOMAIN_IN_FILE",
      allowedDecisions: ["skip"],
    });
  });
});
