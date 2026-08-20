import { Controller, Get, Req } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { SessionPayload } from "@embed-os/contracts";
import type { ActorRequest } from "./access-control.js";

@ApiTags("session")
@Controller("session")
export class SessionController {
  @Get()
  @ApiOperation({ summary: "Получить роль, область доступа и разрешения текущего пользователя" })
  @ApiResponse({ status: 200, description: "Проверенная сервером сессия" })
  getSession(@Req() request: ActorRequest): SessionPayload {
    if (!request.actor) throw new Error("Actor context was not initialized");
    return request.actor;
  }
}
