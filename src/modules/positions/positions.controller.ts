import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ClosedPositionsQuerySchema, type OpenPosition } from "@polymarket-copy/shared";
import { PositionsService } from "./positions.service.ts";

@Controller("positions")
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Get()
  async findAll(): Promise<OpenPosition[]> {
    return await this.positionsService.findAll();
  }

  @Get("closed")
  async findClosed(@Query() rawQuery?: Record<string, unknown>): Promise<
    | OpenPosition[]
    | {
        items: OpenPosition[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
        totals: unknown;
      }
  > {
    if (
      rawQuery &&
      (rawQuery.page !== undefined ||
        rawQuery.limit !== undefined ||
        rawQuery.status !== undefined ||
        rawQuery.since !== undefined)
    ) {
      const parsed = ClosedPositionsQuerySchema.parse(rawQuery);
      return await this.positionsService.findClosedPaginated(parsed);
    }
    return await this.positionsService.findClosed();
  }

  @Get("unredeemed")
  async findUnredeemed(): Promise<OpenPosition[]> {
    return await this.positionsService.findUnredeemedWinningPositions();
  }

  @Post("settle")
  async settle(): Promise<{ settledCount: number; message: string }> {
    const settledCount = await this.positionsService.settleResolvedPositions(true);
    return {
      settledCount,
      message: `${settledCount} position(s) résolue(s) et créditée(s) au cash disponible.`,
    };
  }

  @Post(":conditionId/redeem")
  async recordRedeem(
    @Param("conditionId") conditionId: string,
    @Body() body: { txHash: string }
  ): Promise<OpenPosition> {
    return await this.positionsService.recordPositionRedeemed(conditionId, body.txHash);
  }

  @Get(":id")
  async findById(@Param("id") id: string): Promise<OpenPosition> {
    return await this.positionsService.findById(id);
  }
}
