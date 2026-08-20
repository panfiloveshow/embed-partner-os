import { describe, expect, it } from "vitest";
import { OrganizationImportService } from "./organization-import.service.js";
import { TodayService } from "./today.service.js";

describe("OrganizationImportService", () => {
  it("previews, resolves conflicts and commits every row idempotently", async () => {
    const service = new OrganizationImportService(new TodayService(), fixedClock);
    const preview = await service.preview(
      csv([
        "organization_name,domain,segment,source",
        "Новый партнёр,new-partner.ru,Новости,Пилот",
        "Медиа Новости,medianovosti.ru,Обновлённый сегмент,Таблица",
        "Медиа Новости,media-news-group.ru,Медиа,Таблица",
        "Без домена,,Медиа,Таблица",
      ]),
    );

    expect(preview).toMatchObject({
      status: "preview",
      summary: { total: 4, create: 1, update: 1, conflict: 2, applied: 0 },
    });
    const command = {
      resolutions: [
        { rowNo: 4, decision: "create" as const },
        { rowNo: 5, decision: "skip" as const },
      ],
    };
    const committed = await service.commit(preview.id, command, "import-commit-key-0001");
    const replay = await service.commit(preview.id, command, "import-commit-key-0001");

    expect(replay).toEqual(committed);
    expect(committed).toMatchObject({
      status: "committed",
      completedAt: "2026-08-18T10:00:00.000Z",
      summary: { total: 4, create: 1, update: 1, skip: 0, conflict: 2, applied: 3 },
    });
    expect(committed.rows.map(({ resolvedDecision }) => resolvedDecision)).toEqual([
      "create",
      "update",
      "create",
      "skip",
    ]);
  });

  it("cancels a preview without applying any row", async () => {
    const service = new OrganizationImportService(new TodayService(), fixedClock);
    const preview = await service.preview(
      csv(["organization_name;domain;source", "Новый партнёр;new-partner.ru;Пилот"]),
    );

    const cancelled = await service.cancel(preview.id, "import-cancel-key-0001");

    expect(cancelled).toMatchObject({
      status: "cancelled",
      summary: { total: 1, applied: 0 },
    });
    expect(cancelled.rows[0]).toMatchObject({ entityId: null, appliedAt: null });
  });
});

function csv(lines: string[]) {
  return { fileName: "partners.csv", buffer: Buffer.from(lines.join("\n"), "utf8") };
}

function fixedClock() {
  return new Date("2026-08-18T10:00:00.000Z");
}
