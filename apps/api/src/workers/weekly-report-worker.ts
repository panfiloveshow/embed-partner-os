import "reflect-metadata";
import { setTimeout as wait } from "node:timers/promises";
import { NestFactory } from "@nestjs/core";
import type { ReportPort } from "../report.port.js";
import { REPORT_PORT } from "../report.port.js";
import { AppModule } from "../app.module.js";
import {
  WeeklyReportScheduler,
  nextWeeklyReportDue,
} from "../reporting/weekly-report-scheduler.js";

async function bootstrap() {
  requirePostgresMode();
  const app = await NestFactory.createApplicationContext(AppModule);
  const abort = shutdownController();
  const reports = app.get<ReportPort>(REPORT_PORT);
  const formulaVersion = process.env.WEEKLY_REPORT_FORMULA_VERSION?.trim() || "weekly-v1";
  const scheduler = new WeeklyReportScheduler(reports, () => new Date(), formulaVersion);

  try {
    do {
      const snapshot = await scheduler.runLatestDue();
      console.log(
        JSON.stringify({
          event: "weekly-report.generated",
          snapshotId: snapshot.id,
          periodStart: snapshot.periodStart,
          revision: snapshot.revision,
          dataAsOf: snapshot.dataAsOf,
        }),
      );
      if (process.env.WEEKLY_REPORT_RUN_ONCE === "1") break;

      const dueAt = nextWeeklyReportDue(new Date());
      const delayMs = Math.max(0, dueAt.getTime() - Date.now());
      console.log(JSON.stringify({ event: "weekly-report.waiting", dueAt: dueAt.toISOString() }));
      await wait(delayMs, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!isAbortError(error)) throw error;
  } finally {
    await app.close();
  }
}

function requirePostgresMode() {
  if (process.env.PERSISTENCE_MODE !== "postgres") {
    throw new Error("Weekly report worker requires PERSISTENCE_MODE=postgres for durable runs");
  }
}

function shutdownController() {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
