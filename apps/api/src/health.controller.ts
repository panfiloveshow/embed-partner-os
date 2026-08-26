import { Controller, Get } from "@nestjs/common";
import { PublicRoute } from "./auth/access-control.js";

/**
 * Публичный health-check для балансировщиков, Docker/Kubernetes-проб
 * и внешнего мониторинга. Не требует аутентификации и не раскрывает
 * данных приложения: только режим хранения, аптайм и время.
 */
@Controller("health")
export class HealthController {
  @PublicRoute()
  @Get()
  getHealth() {
    return {
      status: "ok" as const,
      persistenceMode: process.env.PERSISTENCE_MODE === "postgres" ? "postgres" : "memory",
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
