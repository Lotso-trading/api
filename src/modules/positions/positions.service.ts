import type {
    ClosedPositionsQuery,
    ClosedPositionsTotals,
    ClosePositionInput,
    ExecutedTrade,
    OpenPosition,
    SyncRequestResponse,
} from "@lotso-trading/shared";
import { Injectable, NotFoundException, type OnModuleInit, Optional } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { PolymarketMetadataService } from "../../common/services/polymarket-metadata.service.ts";
import { findByIdOrThrow } from "../../common/utils/entity-lookup.util.ts";
import { buildPaginatedResponse, normalizePagination } from "../../common/utils/pagination.util.ts";
import {
    buildTimestampMsExpr,
    CLOSED_LOSS_MATCH,
    CLOSED_POSITION_STATS_ACCUMULATORS,
    CLOSED_WIN_MATCH,
    formatClosedPositionsTotals,
    type RawClosedStatsDoc,
} from "../../common/utils/position-stats.util.ts";
import { type PositionDocument, PositionModel } from "../../database/schemas/position.schema.ts";
import { type TargetDocument, TargetModel } from "../../database/schemas/target.schema.ts";
import { EventsGateway } from "../gateway/events.gateway.ts";
import { DiscordNotifierService } from "../notifications/discord-notifier.service.ts";

@Injectable()
export class PositionsService implements OnModuleInit {
    private readonly metadataService: PolymarketMetadataService;

    constructor(
        @InjectModel(PositionModel.name)
        private readonly positionModel: Model<PositionDocument>,
        @InjectModel(TargetModel.name)
        private readonly targetModel: Model<TargetDocument>,
        private readonly eventsGateway: EventsGateway,
        private readonly discordNotifier: DiscordNotifierService,
        @Optional() metadataService?: PolymarketMetadataService
    ) {
        this.metadataService = metadataService ?? new PolymarketMetadataService();
    }

    onModuleInit(): void {
        // Assainissement et rétro-résolution des métadonnées (dates, eventSlug) au démarrage uniquement.
        // La vérification des marchés clôturés/résolus est exclusivement de la responsabilité du service Bot.
        this.metadataService
            .sanitizeCorruptedEventSlugs(this.positionModel)
            .then(() => this.metadataService.backfillMissingMetadata(this.positionModel))
            .catch((err: unknown) => {
                console.warn("[PositionsService] Erreur assainissement/backfill metadata:", err);
            });
    }

    async sanitizeCorruptedEventSlugs(): Promise<number> {
        return await this.metadataService.sanitizeCorruptedEventSlugs(this.positionModel);
    }

    async resolveMarketMetadata(
        conditionId: string,
        marketSlug?: string,
        assetAddress?: string
    ): Promise<{ endDate?: string; eventSlug?: string }> {
        return await this.metadataService.resolveMarketMetadata(
            conditionId,
            marketSlug,
            assetAddress
        );
    }

    async resolveMarketEndDate(
        conditionId: string,
        marketSlug?: string,
        assetAddress?: string
    ): Promise<string | undefined> {
        return await this.metadataService.resolveMarketEndDate(
            conditionId,
            marketSlug,
            assetAddress
        );
    }

    private async getTargetAlias(address?: string): Promise<string | undefined> {
        if (!address) return undefined;
        try {
            const target = await this.targetModel
                .findOne({ address: address.toLowerCase() })
                .lean()
                .exec();
            return target?.alias;
        } catch (_err: unknown) {
            return undefined;
        }
    }

    private async updateTargetClosedStats(
        targetAddress: string | undefined,
        realizedPnlUsdc: number,
        isWin: boolean
    ): Promise<void> {
        if (!targetAddress) return;
        await this.targetModel
            .updateOne(
                { address: targetAddress.toLowerCase() },
                {
                    $inc: {
                        "stats.realizedPnlUsdc": realizedPnlUsdc,
                        ...(isWin ? { "stats.wonTrades": 1 } : { "stats.lostTrades": 1 }),
                    },
                }
            )
            .catch((err: unknown) =>
                console.warn("[PositionsService] Erreur mise à jour stats cible sur clôture:", err)
            );
    }

    /**
     * Demande au service Bot (via WebSocket) de lancer immédiatement une vérification des résolutions.
     * L'API n'interroge jamais Polymarket pour détecter si une position est clôturée.
     */
    requestPositionSync(): SyncRequestResponse {
        const requestedAt = Date.now();
        const botOnline = this.eventsGateway.isBotConnected();
        if (!botOnline) {
            return {
                requested: false,
                botOnline: false,
                message:
                    "Le bot est hors ligne : impossible de lancer une vérification de résolution pour le moment.",
                requestedAt,
            };
        }

        const sent = this.eventsGateway.sendToBots("bot:check-resolutions", { requestedAt });
        return {
            requested: sent,
            botOnline: true,
            message: sent
                ? "Demande de vérification transmise au bot. Les résultats apparaîtront automatiquement."
                : "Aucune session WebSocket bot disponible pour traiter la demande.",
            requestedAt,
        };
    }

    /**
     * Persiste la clôture d'une position détectée et transmise par le Bot.
     * Atomique et idempotente : plusieurs appels concurrents ne ferment la position qu'une seule fois.
     */
    async closePosition(
        conditionId: string,
        dto: ClosePositionInput
    ): Promise<OpenPosition | null> {
        const existing = await this.positionModel.findOne({
            conditionId,
            status: { $ne: "CLOSED" },
        });

        if (!existing) {
            return null;
        }

        const isWin = dto.closeReason === "RESOLVED_WIN";
        const settledPayoutUsdc =
            dto.settledPayoutUsdc !== undefined
                ? Number(dto.settledPayoutUsdc.toFixed(2))
                : isWin
                  ? Number(existing.totalShares.toFixed(2))
                  : 0;
        const realizedPnlUsdc = Number((settledPayoutUsdc - existing.totalInvestedUsdc).toFixed(2));
        const closedAt = dto.closedAt ?? Date.now();

        const closedMarketPrice =
            dto.closeReason === "RESOLVED_WIN"
                ? 1.0
                : dto.closeReason === "RESOLVED_LOSS"
                  ? 0.0
                  : existing.totalShares > 0
                    ? Math.min(
                          1,
                          Math.max(0, Number((settledPayoutUsdc / existing.totalShares).toFixed(4)))
                      )
                    : 0.0;

        const updatedDoc = await this.positionModel.findOneAndUpdate(
            {
                _id: existing._id,
                status: { $ne: "CLOSED" },
            },
            {
                $set: {
                    status: "CLOSED",
                    closeReason: dto.closeReason,
                    settledPayoutUsdc,
                    realizedPnlUsdc,
                    currentMarketPrice: closedMarketPrice,
                    currentMarketValueUsdc: settledPayoutUsdc,
                    unrealizedPnlUsdc: 0,
                    unrealizedPnlPercent: 0,
                    ...(dto.endDate && !existing.endDate ? { endDate: dto.endDate } : {}),
                    closedAt,
                    updatedAt: closedAt,
                },
            },
            { new: true }
        );

        if (!updatedDoc) {
            return null;
        }

        this.eventsGateway.broadcast("position:closed", {
            conditionId: updatedDoc.conditionId,
            positionId: updatedDoc.positionId,
            closeReason: dto.closeReason,
            settledPayoutUsdc,
            realizedPnlUsdc,
        });

        await this.updateTargetClosedStats(
            updatedDoc.targetAddress,
            realizedPnlUsdc,
            isWin || realizedPnlUsdc > 0
        );

        const mapped = this.mapToPosition(updatedDoc.toObject());
        const alias = await this.getTargetAlias(updatedDoc.targetAddress);
        await this.discordNotifier.sendClosedPositionAlert(mapped, alias);

        return mapped;
    }

    async findAll(): Promise<OpenPosition[]> {
        const docs = await this.positionModel
            .find({
                status: { $ne: "CLOSED" },
                totalShares: { $gt: 0 },
            })
            .sort({ updatedAt: -1 })
            .lean()
            .exec();

        await this.metadataService.enrichPositionsMetadata(docs, this.positionModel);
        return docs.map((doc) => this.mapToPosition(doc));
    }

    async findClosed(): Promise<OpenPosition[]> {
        const docs = await this.positionModel
            .find({ status: "CLOSED" })
            .sort({ closedAt: -1, updatedAt: -1 })
            .limit(100)
            .lean()
            .exec();

        await this.metadataService.enrichPositionsMetadata(docs, this.positionModel);
        return docs.map((doc) => this.mapToPosition(doc));
    }

    async getClosedSummary(since?: number): Promise<ClosedPositionsTotals> {
        const matchQuery: Record<string, unknown> = { status: "CLOSED" };
        if (since && since > 0) {
            const sinceMs = since < 100_000_000_000 ? since * 1000 : since;
            matchQuery.$expr = {
                $gte: [buildTimestampMsExpr("$closedAt", "$updatedAt"), sinceMs],
            };
        }

        const [statsDoc] = (await this.positionModel.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: null,
                    ...CLOSED_POSITION_STATS_ACCUMULATORS,
                },
            },
        ])) as RawClosedStatsDoc[];

        return formatClosedPositionsTotals(statsDoc);
    }

    async findUnredeemedWinningPositions(): Promise<OpenPosition[]> {
        const docs = await this.positionModel
            .find({
                status: "CLOSED",
                closeReason: "RESOLVED_WIN",
                settledPayoutUsdc: { $gt: 0 },
                $or: [
                    { settleTxHash: { $exists: false } },
                    { settleTxHash: "" },
                    { settleTxHash: null },
                ],
            })
            .sort({ closedAt: -1, updatedAt: -1 })
            .lean()
            .exec();

        return docs.map((doc) => this.mapToPosition(doc));
    }

    async recordPositionRedeemed(conditionId: string, txHash: string): Promise<OpenPosition> {
        const updated = await this.positionModel
            .findOneAndUpdate(
                { conditionId },
                {
                    $set: {
                        settleTxHash: txHash,
                        updatedAt: Date.now(),
                    },
                },
                { new: true }
            )
            .lean()
            .exec();

        if (!updated) {
            throw new NotFoundException(
                `Position non trouvée pour conditionId=${conditionId} lors de l'enregistrement du rachat`
            );
        }

        const mapped = this.mapToPosition(updated);
        this.eventsGateway.broadcast("position:redeemed", {
            conditionId,
            txHash,
            settledPayoutUsdc: mapped.settledPayoutUsdc,
        });

        return mapped;
    }

    async findClosedPaginated(query: ClosedPositionsQuery): Promise<{
        items: OpenPosition[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
        totals: ClosedPositionsTotals;
    }> {
        const { page, limit, skip } = normalizePagination(
            query.page ? Number(query.page) : undefined,
            query.limit ? Number(query.limit) : undefined,
            20,
            100
        );

        const matchQuery: Record<string, unknown> = { status: "CLOSED" };
        if (query.status === "WIN") {
            Object.assign(matchQuery, CLOSED_WIN_MATCH);
        } else if (query.status === "LOSS") {
            Object.assign(matchQuery, CLOSED_LOSS_MATCH);
        }

        const since = query.since ? Number(query.since) : undefined;
        if (since && since > 0) {
            const sinceMs = since < 100_000_000_000 ? since * 1000 : since;
            matchQuery.$expr = {
                $gte: [buildTimestampMsExpr("$closedAt", "$updatedAt"), sinceMs],
            };
        }

        const [aggregationResult] = await this.positionModel.aggregate([
            { $match: matchQuery },
            {
                $facet: {
                    items: [
                        { $sort: { closedAt: -1, updatedAt: -1 } },
                        { $skip: skip },
                        { $limit: limit },
                    ],
                    stats: [
                        {
                            $group: {
                                _id: null,
                                ...CLOSED_POSITION_STATS_ACCUMULATORS,
                            },
                        },
                    ],
                },
            },
        ]);

        const rawItems = (aggregationResult?.items || []) as PositionDocument[];
        await this.metadataService.enrichPositionsMetadata(rawItems, this.positionModel);

        const totals = formatClosedPositionsTotals(
            aggregationResult?.stats?.[0] as RawClosedStatsDoc | undefined
        );

        return buildPaginatedResponse(
            rawItems.map((doc) => this.mapToPosition(doc)),
            totals.count,
            page,
            limit,
            { totals }
        );
    }

    async findById(id: string): Promise<OpenPosition> {
        const doc = await findByIdOrThrow(
            this.positionModel,
            id,
            `Position introuvable avec l'ID ${id}`
        );
        return this.mapToPosition(doc);
    }

    async findByMarket(conditionId: string, assetAddress: string): Promise<OpenPosition | null> {
        const doc = await this.positionModel
            .findOne({
                conditionId,
                assetAddress: assetAddress.toLowerCase(),
            })
            .lean()
            .exec();
        return doc ? this.mapToPosition(doc) : null;
    }

    async recordBuy(
        trade: ExecutedTrade,
        marketInfo?: {
            marketSlug?: string;
            eventSlug?: string;
            marketQuestion?: string;
            outcomeLabel?: string;
            endDate?: string;
        }
    ): Promise<OpenPosition> {
        const targetAssetAddress = (trade.assetAddress || trade.conditionId).toLowerCase();
        const existing = await this.positionModel.findOne({
            conditionId: trade.conditionId,
            assetAddress: targetAssetAddress,
            status: { $ne: "CLOSED" },
        });

        let savedDoc: PositionDocument;

        if (!existing) {
            const positionId = `pos_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const providedEventSlug = marketInfo?.eventSlug || trade.eventSlug;
            const needsMetadataLookup = !marketInfo?.endDate || !providedEventSlug;
            const resolvedMeta = needsMetadataLookup
                ? await this.resolveMarketMetadata(
                      trade.conditionId,
                      marketInfo?.marketSlug,
                      trade.assetAddress
                  )
                : {};
            const resolvedEndDate = marketInfo?.endDate || resolvedMeta.endDate;
            const resolvedEventSlug = providedEventSlug || resolvedMeta.eventSlug;

            const newPos = new this.positionModel({
                positionId,
                conditionId: trade.conditionId,
                assetAddress: targetAssetAddress,
                marketSlug: marketInfo?.marketSlug || "market",
                eventSlug: resolvedEventSlug,
                marketQuestion: marketInfo?.marketQuestion || "Polymarket Question",
                outcomeLabel: marketInfo?.outcomeLabel || "Yes",
                endDate: resolvedEndDate,
                status: "OPEN",
                totalShares: trade.shares,
                avgEntryPrice: trade.executedPrice,
                totalInvestedUsdc: trade.costUsdc,
                currentMarketPrice: trade.executedPrice,
                currentMarketValueUsdc: trade.costUsdc,
                unrealizedPnlUsdc: 0,
                unrealizedPnlPercent: 0,
                targetAddress: trade.targetAddress.toLowerCase(),
                openedAt: trade.executedAt,
                updatedAt: trade.executedAt,
            });
            savedDoc = await newPos.save();
        } else {
            const newTotalShares = existing.totalShares + trade.shares;
            const newTotalInvested = existing.totalInvestedUsdc + trade.costUsdc;
            const newAvgPrice =
                newTotalShares > 0 ? newTotalInvested / newTotalShares : existing.avgEntryPrice;

            existing.totalShares = newTotalShares;
            existing.totalInvestedUsdc = newTotalInvested;
            existing.avgEntryPrice = newAvgPrice;
            existing.currentMarketPrice = trade.executedPrice;
            existing.currentMarketValueUsdc = newTotalShares * trade.executedPrice;
            existing.unrealizedPnlUsdc = existing.currentMarketValueUsdc - newTotalInvested;
            existing.unrealizedPnlPercent =
                newTotalInvested > 0 ? (existing.unrealizedPnlUsdc / newTotalInvested) * 100 : 0;
            existing.updatedAt = trade.executedAt;

            const isCorruptedExistingSlug = this.metadataService.isCorruptedEventSlug(
                existing.eventSlug,
                marketInfo?.marketSlug || existing.marketSlug
            );
            if (!existing.endDate || !existing.eventSlug || isCorruptedExistingSlug) {
                const resolved = await this.resolveMarketMetadata(
                    trade.conditionId,
                    marketInfo?.marketSlug,
                    trade.assetAddress
                );
                if (!existing.endDate && (marketInfo?.endDate || resolved.endDate)) {
                    existing.endDate = marketInfo?.endDate || resolved.endDate;
                }
                if (
                    (!existing.eventSlug || isCorruptedExistingSlug) &&
                    (marketInfo?.eventSlug || trade.eventSlug || resolved.eventSlug)
                ) {
                    existing.eventSlug =
                        marketInfo?.eventSlug || trade.eventSlug || resolved.eventSlug;
                }
            }
            savedDoc = await existing.save();
        }

        const result = this.mapToPosition(savedDoc.toObject());
        this.eventsGateway.broadcast("position:updated", result);
        return result;
    }

    async recordSell(trade: ExecutedTrade): Promise<OpenPosition | null> {
        const query: Record<string, unknown> = {
            conditionId: trade.conditionId,
            status: { $ne: "CLOSED" },
        };
        if (trade.assetAddress) {
            query.assetAddress = trade.assetAddress.toLowerCase();
        }
        const existing = await this.positionModel.findOne(query);

        if (!existing) return null;

        const remainingShares = Math.max(0, existing.totalShares - trade.shares);
        if (remainingShares === 0) {
            const proceeds = Math.round(trade.costUsdc * 100) / 100;
            const realizedPnlUsdc = proceeds - existing.totalInvestedUsdc;

            const updated = await this.positionModel.findOneAndUpdate(
                {
                    _id: existing._id,
                    status: { $ne: "CLOSED" },
                },
                {
                    $set: {
                        status: "CLOSED",
                        closeReason: "WHALE_SELL",
                        settledPayoutUsdc: proceeds,
                        realizedPnlUsdc: Number(realizedPnlUsdc.toFixed(2)),
                        currentMarketPrice: trade.executedPrice,
                        currentMarketValueUsdc: proceeds,
                        unrealizedPnlUsdc: 0,
                        unrealizedPnlPercent: 0,
                        closedAt: trade.executedAt,
                        updatedAt: trade.executedAt,
                    },
                },
                { new: true }
            );

            if (!updated) return null;

            this.eventsGateway.broadcast("position:closed", {
                conditionId: trade.conditionId,
                positionId: updated.positionId,
                closeReason: "WHALE_SELL",
                settledPayoutUsdc: proceeds,
                realizedPnlUsdc: updated.realizedPnlUsdc,
            });

            await this.updateTargetClosedStats(
                updated.targetAddress,
                updated.realizedPnlUsdc ?? 0,
                (updated.realizedPnlUsdc ?? 0) > 0
            );

            const mapped = this.mapToPosition(updated.toObject());
            const alias = await this.getTargetAlias(updated.targetAddress);
            await this.discordNotifier.sendClosedPositionAlert(mapped, alias);
            return null;
        }

        const ratioRemaining = remainingShares / existing.totalShares;
        existing.totalShares = remainingShares;
        existing.totalInvestedUsdc = existing.totalInvestedUsdc * ratioRemaining;
        existing.currentMarketPrice = trade.executedPrice;
        existing.currentMarketValueUsdc = remainingShares * trade.executedPrice;
        existing.unrealizedPnlUsdc = existing.currentMarketValueUsdc - existing.totalInvestedUsdc;
        existing.unrealizedPnlPercent =
            existing.totalInvestedUsdc > 0
                ? (existing.unrealizedPnlUsdc / existing.totalInvestedUsdc) * 100
                : 0;
        existing.updatedAt = trade.executedAt;

        const saved = await existing.save();
        const result = this.mapToPosition(saved.toObject());
        this.eventsGateway.broadcast("position:updated", result);
        return result;
    }

    async clearPositions(): Promise<void> {
        await this.positionModel.deleteMany({});
        this.eventsGateway.broadcast("positions:cleared", {});
    }

    private mapToPosition(rawDoc: unknown): OpenPosition {
        const doc = rawDoc as Record<string, unknown>;
        const statusVal = doc.status === "CLOSED" ? "CLOSED" : "OPEN";
        const closeReasonVal = doc.closeReason ? String(doc.closeReason) : undefined;

        return {
            id: String(doc.positionId ?? doc._id),
            conditionId: String(doc.conditionId),
            assetAddress: String(doc.assetAddress),
            marketSlug: String(doc.marketSlug),
            eventSlug: doc.eventSlug ? String(doc.eventSlug) : undefined,
            marketQuestion: String(doc.marketQuestion),
            outcomeLabel: String(doc.outcomeLabel),
            endDate: doc.endDate ? String(doc.endDate) : undefined,
            status: statusVal,
            closeReason: closeReasonVal as OpenPosition["closeReason"],
            settledPayoutUsdc:
                doc.settledPayoutUsdc !== undefined && doc.settledPayoutUsdc !== null
                    ? Number(doc.settledPayoutUsdc)
                    : undefined,
            realizedPnlUsdc:
                doc.realizedPnlUsdc !== undefined && doc.realizedPnlUsdc !== null
                    ? Number(doc.realizedPnlUsdc)
                    : undefined,
            settleTxHash: doc.settleTxHash ? String(doc.settleTxHash) : undefined,
            closedAt: doc.closedAt ? Number(doc.closedAt) : undefined,
            totalShares: Number(doc.totalShares),
            avgEntryPrice: Number(doc.avgEntryPrice),
            totalInvestedUsdc: Number(doc.totalInvestedUsdc),
            currentMarketPrice: Number(doc.currentMarketPrice),
            currentMarketValueUsdc: Number(doc.currentMarketValueUsdc),
            unrealizedPnlUsdc: Number(doc.unrealizedPnlUsdc),
            unrealizedPnlPercent: Number(doc.unrealizedPnlPercent),
            targetAddress: String(doc.targetAddress),
            openedAt: Number(doc.openedAt),
            updatedAt: Number(doc.updatedAt),
        };
    }
}
