import { Body, Controller, Get, Post, Query, UsePipes } from "@nestjs/common";
import {
  type ExecutedTrade,
  ExecutedTradeSchema,
  type PaginationQuery,
  PaginationQuerySchema,
} from "@polymarket-copy/shared";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe.ts";
import { TradesService } from "./trades.service.ts";

@Controller("trades")
export class TradesController {
  constructor(private readonly tradesService: TradesService) {}

  @Get()
  async findAll(
    @Query(new ZodValidationPipe(PaginationQuerySchema)) query: PaginationQuery
  ): Promise<{
    items: ExecutedTrade[];
    total: number;
    page: number;
    limit: number;
  }> {
    return await this.tradesService.findAll(query);
  }

  @Post()
  @UsePipes(new ZodValidationPipe(ExecutedTradeSchema))
  async recordTrade(@Body() trade: ExecutedTrade): Promise<ExecutedTrade> {
    return await this.tradesService.recordTrade(trade);
  }

  @Post("reset-simulation")
  async resetSimulation(): Promise<{ success: boolean; deletedTradesCount: number }> {
    return await this.tradesService.resetSimulation();
  }
}
