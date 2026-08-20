import { describe, expect, it } from "vitest";
import {
  defaultSlaThresholds,
  parseUpdateSlaSettingsCommand,
  processSchemaWithSla,
  slaSettingsFromProcessDefinition,
} from "./sla-settings.js";

describe("SLA settings", () => {
  it("validates every working stage and normalizes the change reason", () => {
    const command = parseUpdateSlaSettingsCommand({
      version: 2,
      escalationAfterDays: 4,
      thresholds: { ...defaultSlaThresholds, S4: 6 },
      reason: "  Скорректировали срок диалога по пилоту  ",
    });

    expect(command).toMatchObject({ version: 2, escalationAfterDays: 4 });
    expect(command.thresholds.S4).toBe(6);
    expect(command.reason).toBe("Скорректировали срок диалога по пилоту");
  });

  it("rejects a missing or out-of-range threshold", () => {
    expect(() =>
      parseUpdateSlaSettingsCommand({
        version: 1,
        escalationAfterDays: 3,
        thresholds: { ...defaultSlaThresholds, S7: 0 },
        reason: "Проверка валидации",
      }),
    ).toThrow("Настройки SLA не сохранены");
  });

  it("reads historical definitions with safe defaults and preserves the rest of the schema", () => {
    const payload = slaSettingsFromProcessDefinition({
      id: "process-1",
      version: 1,
      publishedAt: new Date("2026-08-17T06:00:00.000Z"),
      schema: { stages: ["S0", "S1"] },
      affectedOpportunities: 12,
    });
    expect(payload.stages.find(({ code }) => code === "S7")?.thresholdDays).toBe(7);

    const schema = processSchemaWithSla(
      { stages: ["S0", "S1"], metadata: { owner: "sales-ops" } },
      parseUpdateSlaSettingsCommand({
        version: 1,
        escalationAfterDays: 5,
        thresholds: defaultSlaThresholds,
        reason: "Публикация порогов",
      }),
    );
    expect(schema).toMatchObject({
      stages: ["S0", "S1"],
      metadata: { owner: "sales-ops" },
      sla: { escalationAfterDays: 5 },
    });
  });
});
