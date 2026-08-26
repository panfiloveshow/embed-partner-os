import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { RADAR_PORT, type RadarPort } from "../radar.port.js";

/**
 * Обрабатывает запросы «Проверить» прямо в процессе API.
 *
 * Раньше пользовательские проверки в PostgreSQL-режиме выполнял только
 * отдельный worker `radar-recheck`: если он не запущен, кандидат навсегда
 * зависал с `inspectionPending: true` и Радар казался сломанным. Теперь API
 * сам подхватывает очередь — отдельный воркер остаётся опциональным
 * (для вынесения проверок на выделенный узел задайте RADAR_INLINE_INSPECTION=0).
 *
 * Обработка идемпотентна: параллельный запуск с воркером не создаёт
 * повторных исследований и не дублирует evidence.
 */
@Injectable()
export class RadarInlineInspectionService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private static readonly BATCH_SIZE = 25;
  private static readonly DEFAULT_POLL_MS = 15_000;
  private static readonly MIN_POLL_MS = 1_000;
  private static readonly MAX_POLL_MS = 60 * 60_000;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@Inject(RADAR_PORT) private readonly radar: RadarPort) {}

  onApplicationBootstrap() {
    if (!this.enabled()) return;
    const pollMs = this.pollMs();
    this.timer = setInterval(() => void this.runBatch(), pollMs);
    this.timer.unref?.();
    // Первый прогон сразу после старта: догоняем запросы, оставшиеся
    // с прошлого запуска процесса.
    setTimeout(() => void this.runBatch(), 0).unref?.();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private enabled() {
    return (
      process.env.PERSISTENCE_MODE === "postgres" &&
      process.env.RADAR_INLINE_INSPECTION !== "0"
    );
  }

  private pollMs() {
    const raw = Number(process.env.RADAR_INSPECTION_POLL_MS);
    if (!Number.isFinite(raw)) return RadarInlineInspectionService.DEFAULT_POLL_MS;
    return Math.min(
      Math.max(Math.floor(raw), RadarInlineInspectionService.MIN_POLL_MS),
      RadarInlineInspectionService.MAX_POLL_MS,
    );
  }

  private async runBatch() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.radar.processRequestedInspections(
        RadarInlineInspectionService.BATCH_SIZE,
      );
      if (result.processed > 0 || result.failed > 0) {
        console.log(
          JSON.stringify({ event: "radar-inspection.inline-batch", ...result }),
        );
      }
    } catch (error) {
      // Ошибка очереди не должна ронять API: следующий тик повторит попытку.
      console.error(
        JSON.stringify({
          event: "radar-inspection.inline-batch-failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
