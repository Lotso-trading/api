import type { AddTargetInput, TargetTrader, UpdateTargetInput } from "@lotso-trading/shared";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { type PositionDocument, PositionModel } from "../../database/schemas/position.schema.ts";
import { type TargetDocument, TargetModel } from "../../database/schemas/target.schema.ts";
import { EventsGateway } from "../gateway/events.gateway.ts";

interface AggregatedTargetStats {
    realizedPnlUsdc: number;
    wonTrades: number;
    lostTrades: number;
    winRatePercent: number;
}

@Injectable()
export class TargetsService {
    constructor(
        @InjectModel(TargetModel.name)
        private readonly targetModel: Model<TargetDocument>,
        @InjectModel(PositionModel.name)
        private readonly positionModel: Model<PositionDocument>,
        private readonly eventsGateway: EventsGateway
    ) {}

    private async getTargetsStatsAggregated(): Promise<Map<string, AggregatedTargetStats>> {
        const statsMap = new Map<string, AggregatedTargetStats>();
        try {
            const results = await this.positionModel.aggregate([
                { $match: { status: "CLOSED" } },
                {
                    $group: {
                        _id: { $toLower: "$targetAddress" },
                        realizedPnlUsdc: { $sum: "$realizedPnlUsdc" },
                        wonTrades: {
                            $sum: {
                                $cond: [
                                    {
                                        $or: [
                                            { $eq: ["$closeReason", "RESOLVED_WIN"] },
                                            { $gt: ["$realizedPnlUsdc", 0] },
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                        lostTrades: {
                            $sum: {
                                $cond: [
                                    {
                                        $or: [
                                            { $eq: ["$closeReason", "RESOLVED_LOSS"] },
                                            { $lt: ["$realizedPnlUsdc", 0] },
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                    },
                },
            ]);

            for (const row of results) {
                if (!row._id) continue;
                const won = Number(row.wonTrades || 0);
                const lost = Number(row.lostTrades || 0);
                const total = won + lost;
                statsMap.set(String(row._id), {
                    realizedPnlUsdc: Math.round(Number(row.realizedPnlUsdc || 0) * 100) / 100,
                    wonTrades: won,
                    lostTrades: lost,
                    winRatePercent: total > 0 ? Math.round((won / total) * 1000) / 10 : 0,
                });
            }
        } catch (err: unknown) {
            console.warn("[TargetsService] Erreur lors de l'agrégation des stats cibles:", err);
        }
        return statsMap;
    }

    async findAll(): Promise<TargetTrader[]> {
        const [docs, statsMap] = await Promise.all([
            this.targetModel.find().lean().exec(),
            this.getTargetsStatsAggregated(),
        ]);
        return docs.map((doc) =>
            this.mapToTrader(doc, statsMap.get(String(doc.address).toLowerCase()))
        );
    }

    async findById(id: string): Promise<TargetTrader> {
        const doc = await this.targetModel.findById(id).lean().exec();
        if (!doc) {
            throw new NotFoundException(`Baleine cible introuvable avec l'ID ${id}`);
        }
        const statsMap = await this.getTargetsStatsAggregated();
        return this.mapToTrader(doc, statsMap.get(String(doc.address).toLowerCase()));
    }

    async findByAddress(address: string): Promise<TargetTrader | null> {
        const doc = await this.targetModel
            .findOne({ address: address.toLowerCase() })
            .lean()
            .exec();
        if (!doc) return null;
        const statsMap = await this.getTargetsStatsAggregated();
        return this.mapToTrader(doc, statsMap.get(String(doc.address).toLowerCase()));
    }

    async create(dto: AddTargetInput): Promise<TargetTrader> {
        const existing = await this.findByAddress(dto.address);
        if (existing) {
            throw new BadRequestException(`Une cible avec l'adresse ${dto.address} existe déjà`);
        }

        const created = new this.targetModel({
            address: dto.address.toLowerCase(),
            proxyAddress: dto.proxyAddress?.toLowerCase(),
            username: dto.username,
            alias: dto.alias,
            enabled: dto.enabled,
            maxUsdcPerTrade: dto.maxUsdcPerTrade,
            weightMultiplier: dto.weightMultiplier,
            stats: {
                totalCopiedTrades: 0,
                totalCopiedVolumeUsdc: 0,
                realizedPnlUsdc: 0,
                winRatePercent: 0,
            },
        });

        const saved = await created.save();
        const result = this.mapToTrader(saved.toObject());
        this.eventsGateway.broadcast("target:created", result);
        return result;
    }

    async update(id: string, dto: UpdateTargetInput): Promise<TargetTrader> {
        const updated = await this.targetModel
            .findByIdAndUpdate(
                id,
                {
                    $set: {
                        ...(dto.alias !== undefined && { alias: dto.alias }),
                        ...(dto.proxyAddress !== undefined && {
                            proxyAddress: dto.proxyAddress.toLowerCase(),
                        }),
                        ...(dto.username !== undefined && { username: dto.username }),
                        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
                        ...(dto.maxUsdcPerTrade !== undefined && {
                            maxUsdcPerTrade: dto.maxUsdcPerTrade,
                        }),
                        ...(dto.weightMultiplier !== undefined && {
                            weightMultiplier: dto.weightMultiplier,
                        }),
                    },
                },
                { new: true }
            )
            .lean()
            .exec();

        if (!updated) {
            throw new NotFoundException(`Baleine cible introuvable avec l'ID ${id}`);
        }

        const result = this.mapToTrader(updated);
        this.eventsGateway.broadcast("target:updated", result);
        return result;
    }

    async delete(id: string): Promise<boolean> {
        const result = await this.targetModel.findByIdAndDelete(id).exec();
        if (!result) {
            throw new NotFoundException(`Baleine cible introuvable avec l'ID ${id}`);
        }
        this.eventsGateway.broadcast("target:deleted", { id });
        return true;
    }

    private mapToTrader(rawDoc: unknown, aggregatedStats?: AggregatedTargetStats): TargetTrader {
        const doc = rawDoc as Record<string, unknown>;
        const baseStats = (doc.stats as TargetTrader["stats"]) || {
            totalCopiedTrades: 0,
            totalCopiedVolumeUsdc: 0,
            realizedPnlUsdc: 0,
            winRatePercent: 0,
        };

        const stats: TargetTrader["stats"] = {
            totalCopiedTrades: Number(baseStats.totalCopiedTrades || 0),
            totalCopiedVolumeUsdc: Number(baseStats.totalCopiedVolumeUsdc || 0),
            realizedPnlUsdc: aggregatedStats
                ? aggregatedStats.realizedPnlUsdc
                : Number(baseStats.realizedPnlUsdc || 0),
            winRatePercent: aggregatedStats
                ? aggregatedStats.winRatePercent
                : Number(baseStats.winRatePercent || 0),
            wonTrades: aggregatedStats?.wonTrades ?? Number(baseStats.wonTrades || 0),
            lostTrades: aggregatedStats?.lostTrades ?? Number(baseStats.lostTrades || 0),
        };

        return {
            id: String(doc._id ?? doc.id),
            address: String(doc.address),
            proxyAddress: doc.proxyAddress ? String(doc.proxyAddress) : undefined,
            username: doc.username ? String(doc.username) : undefined,
            alias: String(doc.alias),
            enabled: Boolean(doc.enabled),
            maxUsdcPerTrade:
                doc.maxUsdcPerTrade !== undefined ? Number(doc.maxUsdcPerTrade) : undefined,
            weightMultiplier: Number(doc.weightMultiplier ?? 1.0),
            stats,
            createdAt: doc.createdAt instanceof Date ? doc.createdAt.getTime() : Date.now(),
            updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.getTime() : Date.now(),
        };
    }
}
