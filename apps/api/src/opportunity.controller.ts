import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type {
  FunnelPayload,
  OpportunityStageTransitionResult,
} from "@embed-os/contracts";
import { parseIdempotencyKey } from "./application/idempotency.js";
import { OPPORTUNITY_PORT, type OpportunityPort } from "./opportunity.port.js";
import { RequirePermission } from "./auth/access-control.js";

@ApiTags("opportunities")
@Controller("opportunities")
export class OpportunityController {
  constructor(@Inject(OPPORTUNITY_PORT) private readonly opportunities: OpportunityPort) {}

  @Get()
  @RequirePermission("opportunities.read")
  @ApiOperation({ summary: "Получить единую выборку воронки для канбана и таблицы" })
  @ApiResponse({ status: 200, description: "Срез воронки по команде" })
  list(): Promise<FunnelPayload> {
    return this.opportunities.list();
  }

  @Post(":opportunityId/stage-transitions")
  @RequirePermission("opportunities.stage.write")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Выполнить проверяемый переход стадии возможности" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 200, description: "Стадия изменена" })
  transition(
    @Param("opportunityId") opportunityId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
  ): Promise<OpportunityStageTransitionResult> {
    return this.opportunities.transition(
      opportunityId,
      body,
      parseIdempotencyKey(rawIdempotencyKey),
    );
  }
}
