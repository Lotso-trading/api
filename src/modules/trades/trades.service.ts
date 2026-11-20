import type { ExecutedTrade, TradesQuery } from "@lotso-trading/shared";
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import {
    buildPaginatedResponse,
    escapeRegex,
    normalizePagination,
} from "../../common/utils/pagination.util.ts";
import { type TargetDocument, TargetModel } from "../../database/schemas/target.schema.ts";
import { type TradeDocument, TradeModel } from "../../database/schemas/trade.schema.ts";
import { EventsGateway } from "../gateway/events.gateway.ts";
import { PositionsService } from "../positions/positions.service.ts";

const ALLOWED_SORT_FIELDS: Record<TradesQuery["sortBy"], string> = {
    executedAt: "executedAt",
    costUsdc: "costUsdc",
    shares: "shares",
    executedPrice: "executedPrice",
    slippagePercent: "slippagePercent",
};

@Injectable()
export class TradesService {
    constructor(
        @InjectModel(TradeModel.name)
        private readonly tradeModel: Model<TradeDocument>,
        @InjectModel(TargetModel.name)
        private readonly targetModel: Model<TargetDocument>,
        private readonly positionsService: PositionsService,
        private readonly eventsGateway: EventsGateway
    ) {}

    async findAll(query: TradesQuery): Promise<{
        items: ExecutedTrade[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    }> {
        const filter: Record<string, unknown> = {};
        if (query.status) filter.status = query.status;
        if (query.targetAddress) filter.targetAddress = query.targetAddress.toLowerCase();
        if (query.side) filter.side = query.side;

        if (query.isDryRun === "DRY_RUN") {
            filter.isDryRun = true;
        } else if (query.isDryRun === "LIVE") {
            filter.isDryRun = false;
        }

        if (query.search && query.search.trim().length > 0) {
            const regex = new RegExp(escapeRegex(query.search.trim()), "i");
            filter.$or = [
                { marketQuestion: regex },
                { marketSlug: regex },
                { outcomeLabel: regex },
                { rejectionReason: regex },
            ];
        }

        const { page, limit, skip } = normalizePagination(query.page, query.limit, 20, 100);
        const sortField = ALLOWED_SORT_FIELDS[query.sortBy] ?? "executedAt";
        const sortDirection = query.sortOrder === "asc" ? 1 : -1;
        const sortSpec: Record<string, 1 | -1> =
            sortField === "executedAt"
                ? { executedAt: sortDirection }
                : { [sortField]: sortDirection, executedAt: -1 };

        const [docs, total] = await Promise.all([
            this.tradeModel.find(filter).sort(sortSpec).skip(skip).limit(limit).lean().exec(),
            this.tradeModel.countDocuments(filter).exec(),
        ]);

        return buildPaginatedResponse(
            docs.map((doc) => this.mapToExecutedTrade(doc)),
            total,
            page,
            limit
        );
    }

    async recordTrade(trade: ExecutedTrade): Promise<ExecutedTrade> {
        // Vérification anti-doublon
        const existing = await this.tradeModel
            .findOne({
                $or: [
                    { tradeId: trade.id },
                    { detectedTradeId: trade.detectedTradeId },
                    ...(trade.transactionHash ? [{ transactionHash: trade.transactionHash }] : []),
                ],
            })
            .lean()
            .exec();

        if (existing) {
            return this.mapToExecutedTrade(existing);
        }

        const created = new this.tradeModel({
            tradeId: trade.id,
            detectedTradeId: trade.detectedTradeId,
            targetAddress: trade.targetAddress.toLowerCase(),
            conditionId: trade.conditionId,
            marketSlug: trade.marketSlug,
            eventSlug: trade.eventSlug,
            marketQuestion: trade.marketQuestion,
            outcomeLabel: trade.outcomeLabel,
            side: trade.side,
            targetPrice: trade.targetPrice,
            executedPrice: trade.executedPrice,
            slippagePercent: trade.slippagePercent,
            shares: trade.shares,
            costUsdc: trade.costUsdc,
            orderId: trade.orderId,
            transactionHash: trade.transactionHash,
            status: trade.status,
            rejectionReason: trade.rejectionReason,
            isDryRun: trade.isDryRun,
            executedAt: trade.executedAt,
        });

        const saved = await created.save();
        const result = this.mapToExecutedTrade(saved.toObject());

        // Si le trade a été rempli (FILLED), mettre à jour la position et les stats de la cible
        if (trade.status === "FILLED") {
            if (trade.side === "BUY") {
                await this.positionsService.recordBuy(trade, {
                    marketSlug: trade.marketSlug,
                    eventSlug: trade.eventSlug,
                    marketQuestion: trade.marketQuestion,
                    outcomeLabel: trade.outcomeLabel,
                    endDate: trade.endDate,
                });
            } else if (trade.side === "SELL") {
                await this.positionsService.recordSell(trade);
            }

            await this.targetModel.findOneAndUpdate(
                { address: trade.targetAddress.toLowerCase() },
                {
                    $inc: {
                        "stats.totalCopiedTrades": 1,
                        "stats.totalCopiedVolumeUsdc": trade.costUsdc,
                    },
                }
            );
        }

        this.eventsGateway.broadcast("trade:created", result);
        return result;
    }

    async resetSimulation(): Promise<{ success: boolean; deletedTradesCount: number }> {
        const deleteRes = await this.tradeModel.deleteMany({ isDryRun: true }).exec();
        await this.positionsService.clearPositions();
        await this.targetModel
            .updateMany(
                {},
                {
                    $set: {
                        "stats.totalCopiedTrades": 0,
                        "stats.totalCopiedVolumeUsdc": 0,
                        "stats.realizedPnlUsdc": 0,
                        "stats.winRatePercent": 0,
                        "stats.wonTrades": 0,
                        "stats.lostTrades": 0,
                    },
                }
            )
            .exec();

        this.eventsGateway.broadcast("simulation:reset", { timestamp: Date.now() });
        return {
            success: true,
            deletedTradesCount: deleteRes.deletedCount || 0,
        };
    }

    private mapToExecutedTrade(rawDoc: unknown): ExecutedTrade {
        const doc = rawDoc as Record<string, unknown>;
        return {
            id: String(doc.tradeId ?? doc._id),
            detectedTradeId: String(doc.detectedTradeId),
            targetAddress: String(doc.targetAddress),
            conditionId: String(doc.conditionId),
            marketSlug: doc.marketSlug ? String(doc.marketSlug) : undefined,
            eventSlug: doc.eventSlug ? String(doc.eventSlug) : undefined,
            marketQuestion: doc.marketQuestion ? String(doc.marketQuestion) : undefined,
            outcomeLabel: doc.outcomeLabel ? String(doc.outcomeLabel) : undefined,
            side: doc.side as ExecutedTrade["side"],
            targetPrice: Number(doc.targetPrice),
            executedPrice: Number(doc.executedPrice),
            slippagePercent: Number(doc.slippagePercent),
            shares: Number(doc.shares),
            costUsdc: Number(doc.costUsdc),
            orderId: doc.orderId ? String(doc.orderId) : undefined,
            transactionHash: doc.transactionHash ? String(doc.transactionHash) : undefined,
            status: doc.status as ExecutedTrade["status"],
            rejectionReason: doc.rejectionReason ? String(doc.rejectionReason) : undefined,
            isDryRun: Boolean(doc.isDryRun),
            executedAt: Number(doc.executedAt),
        };
    }
}
