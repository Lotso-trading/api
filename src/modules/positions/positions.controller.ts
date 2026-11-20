import {
    ClosedPositionsQuerySchema,
    type ClosedPositionsTotals,
    type ClosePositionInput,
    ClosePositionInputSchema,
    type OpenPosition,
    type SyncRequestResponse,
} from "@lotso-trading/shared";
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe.ts";
import { PositionsService } from "./positions.service.ts";

@Controller("positions")
export class PositionsController {
    constructor(private readonly positionsService: PositionsService) {}

    @Get()
    async findAll(): Promise<OpenPosition[]> {
        return await this.positionsService.findAll();
    }

    @Get("closed-summary")
    async getClosedSummary(@Query("since") rawSince?: string): Promise<ClosedPositionsTotals> {
        const since = rawSince !== undefined ? Number(rawSince) : undefined;
        const validSince =
            since !== undefined && !Number.isNaN(since) && since > 0 ? since : undefined;
        return await this.positionsService.getClosedSummary(validSince);
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
              totals: ClosedPositionsTotals;
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

    @Post("sync-request")
    requestSync(): SyncRequestResponse {
        return this.positionsService.requestPositionSync();
    }

    @Post("settle")
    settle(): SyncRequestResponse {
        return this.positionsService.requestPositionSync();
    }

    @Post(":conditionId/close")
    async closePosition(
        @Param("conditionId") conditionId: string,
        @Body(new ZodValidationPipe(ClosePositionInputSchema)) dto: ClosePositionInput
    ): Promise<OpenPosition | null> {
        return await this.positionsService.closePosition(conditionId, dto);
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
