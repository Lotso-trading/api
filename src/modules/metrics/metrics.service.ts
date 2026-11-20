import type {
    PeriodGranularity,
    PeriodSummaryItem,
    PeriodSummaryQueryParsed,
    PeriodSummaryResponse,
} from "@lotso-trading/shared";
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { buildPaginatedResponse, normalizePagination } from "../../common/utils/pagination.util.ts";
import {
    buildTimestampMsExpr,
    CLOSED_POSITION_STATS_ACCUMULATORS,
    formatClosedPositionsTotals,
    type RawClosedStatsDoc,
} from "../../common/utils/position-stats.util.ts";
import { type ConfigDocument, ConfigModel } from "../../database/schemas/config.schema.ts";
import { type PositionDocument, PositionModel } from "../../database/schemas/position.schema.ts";
import { type TargetDocument, TargetModel } from "../../database/schemas/target.schema.ts";
import { type TradeDocument, TradeModel } from "../../database/schemas/trade.schema.ts";
import { EventsGateway } from "../gateway/events.gateway.ts";

export interface GlobalMetrics {
    totalTradedVolumeUsdc: number;
    totalCopiedTrades: number;
    totalRejectedTrades: number;
    activePositionsCount: number;
    closedPositionsCount: number;
    initialCapitalUsdc: number;
    totalInvestedUsdc: number;
    currentPositionsValueUsdc: number;
    unrealizedPnlUsdc: number;
    realizedPnlUsdc: number;
    totalSettledPayoutUsdc: number;
    availableCashUsdc: number;
    totalPortfolioValueUsdc: number;
    activeTargetsCount: number;
}

export interface PerformancePoint {
    timestamp: number;
    tradeId?: string;
    side?: "BUY" | "SELL";
    shares?: number;
    price?: number;
    costUsdc?: number;
    targetAddress?: string;
    targetAlias?: string;
    myCumulativePnlUsdc: number;
    portfolioValueUsdc: number;
    whaleCumulativeUsdc: number;
}

const GRANULARITY_DATE_FORMAT: Record<PeriodGranularity, string> = {
    day: "%Y-%m-%d",
    week: "%G-W%V",
    month: "%Y-%m",
    year: "%Y",
};

function resolveSafeTimeZone(rawTz?: string): string {
    const candidate = rawTz?.trim() || "UTC";
    try {
        new Intl.DateTimeFormat("fr-FR", { timeZone: candidate });
        return candidate;
    } catch {
        return "UTC";
    }
}

function getIsoWeekDateRange(isoYear: number, isoWeek: number): { start: Date; end: Date } {
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86_400_000);
    const start = new Date(week1Monday.getTime() + (isoWeek - 1) * 7 * 86_400_000);
    const end = new Date(start.getTime() + 6 * 86_400_000 + 86_399_999);
    return { start, end };
}

function formatPeriodBucket(
    periodKey: string,
    granularity: PeriodGranularity
): { periodLabel: string; startTimestamp: number; endTimestamp: number } {
    if (granularity === "day") {
        const [y, m, d] = periodKey.split("-").map(Number);
        const start = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1, 0, 0, 0, 0));
        const end = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1, 23, 59, 59, 999));
        const label = start.toLocaleDateString("fr-FR", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
        });
        return { periodLabel: label, startTimestamp: start.getTime(), endTimestamp: end.getTime() };
    }

    if (granularity === "week") {
        const match = /^(\d{4})-W(\d{2})$/.exec(periodKey);
        if (match) {
            const year = Number(match[1]);
            const week = Number(match[2]);
            const { start, end } = getIsoWeekDateRange(year, week);
            const startStr = start.toLocaleDateString("fr-FR", {
                day: "numeric",
                month: "short",
                timeZone: "UTC",
            });
            const endStr = end.toLocaleDateString("fr-FR", {
                day: "numeric",
                month: "short",
                timeZone: "UTC",
            });
            return {
                periodLabel: `S${String(week).padStart(2, "0")} ${year} (${startStr} – ${endStr})`,
                startTimestamp: start.getTime(),
                endTimestamp: end.getTime(),
            };
        }
    }

    if (granularity === "month") {
        const [y, m] = periodKey.split("-").map(Number);
        const start = new Date(Date.UTC(y || 1970, (m || 1) - 1, 1, 0, 0, 0, 0));
        const end = new Date(Date.UTC(y || 1970, m || 1, 0, 23, 59, 59, 999));
        const rawLabel = start.toLocaleDateString("fr-FR", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
        });
        const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);
        return { periodLabel: label, startTimestamp: start.getTime(), endTimestamp: end.getTime() };
    }

    const year = Number(periodKey) || 1970;
    const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    return {
        periodLabel: String(year),
        startTimestamp: start.getTime(),
        endTimestamp: end.getTime(),
    };
}

interface PeriodPositionAggRow extends RawClosedStatsDoc {
    _id: string;
}

interface PeriodTradeAggRow {
    _id: string;
    tradesCount: number;
}

@Injectable()
export class MetricsService {
    constructor(
        @InjectModel(TradeModel.name)
        private readonly tradeModel: Model<TradeDocument>,
        @InjectModel(PositionModel.name)
        private readonly positionModel: Model<PositionDocument>,
        @InjectModel(TargetModel.name)
        private readonly targetModel: Model<TargetDocument>,
        @InjectModel(ConfigModel.name)
        private readonly configModel: Model<ConfigDocument>,
        private readonly eventsGateway: EventsGateway
    ) {}

    async broadcastMetrics(): Promise<GlobalMetrics> {
        const metrics = await this.getMetrics();
        this.eventsGateway.broadcast("metrics:updated", metrics);
        return metrics;
    }

    async getMetrics(): Promise<GlobalMetrics> {
        const [tradeAgg, positionAgg, closedAgg, activeTargetsCount, rejectedCount, configDoc] =
            await Promise.all([
                this.tradeModel.aggregate([
                    { $match: { status: "FILLED" } },
                    {
                        $group: {
                            _id: null,
                            totalVolume: { $sum: "$costUsdc" },
                            totalTrades: { $sum: 1 },
                        },
                    },
                ]),
                this.positionModel.aggregate([
                    { $match: { status: { $ne: "CLOSED" }, totalShares: { $gt: 0 } } },
                    {
                        $group: {
                            _id: null,
                            totalInvested: { $sum: "$totalInvestedUsdc" },
                            totalCurrentValue: { $sum: "$currentMarketValueUsdc" },
                            totalUnrealizedPnl: { $sum: "$unrealizedPnlUsdc" },
                            count: { $sum: 1 },
                        },
                    },
                ]),
                this.positionModel.aggregate([
                    { $match: { status: "CLOSED" } },
                    {
                        $group: {
                            _id: null,
                            totalRealizedPnl: { $sum: "$realizedPnlUsdc" },
                            totalSettledPayout: { $sum: "$settledPayoutUsdc" },
                            count: { $sum: 1 },
                        },
                    },
                ]),
                this.targetModel.countDocuments({ enabled: true }).exec(),
                this.tradeModel.countDocuments({ status: "REJECTED" }).exec(),
                this.configModel.findOne({ key: "singleton" }).lean().exec(),
            ]);

        const tradeStats = tradeAgg[0] || { totalVolume: 0, totalTrades: 0 };
        const positionStats = positionAgg[0] || {
            totalInvested: 0,
            totalCurrentValue: 0,
            totalUnrealizedPnl: 0,
            count: 0,
        };
        const closedStats = closedAgg[0] || {
            totalRealizedPnl: 0,
            totalSettledPayout: 0,
            count: 0,
        };

        const initialCapitalUsdc = Number(
            configDoc?.simulatedBalanceUsdc ??
                Number(Deno.env.get("SIMULATED_BALANCE_USDC")) ??
                1000.0
        );
        const totalInvestedUsdc = Number(positionStats.totalInvested || 0);
        const realizedPnlUsdc = Number(closedStats.totalRealizedPnl || 0);
        const availableCashUsdc = Math.max(
            0,
            initialCapitalUsdc - totalInvestedUsdc + realizedPnlUsdc
        );
        const currentPositionsValueUsdc = Number(positionStats.totalCurrentValue || 0);
        const totalPortfolioValueUsdc = availableCashUsdc + currentPositionsValueUsdc;

        return {
            totalTradedVolumeUsdc: Number(tradeStats.totalVolume || 0),
            totalCopiedTrades: Number(tradeStats.totalTrades || 0),
            totalRejectedTrades: rejectedCount,
            activePositionsCount: positionStats.count || 0,
            closedPositionsCount: closedStats.count || 0,
            initialCapitalUsdc,
            totalInvestedUsdc,
            currentPositionsValueUsdc,
            unrealizedPnlUsdc: Number(positionStats.totalUnrealizedPnl || 0),
            realizedPnlUsdc,
            totalSettledPayoutUsdc: Number(closedStats.totalSettledPayout || 0),
            availableCashUsdc,
            totalPortfolioValueUsdc,
            activeTargetsCount,
        };
    }

    async getPerformanceHistory(): Promise<PerformancePoint[]> {
        const [targets, trades, closedPositions, openPositions, configDoc] = await Promise.all([
            this.targetModel.find({}).lean().exec(),
            this.tradeModel.find({ status: "FILLED" }).sort({ executedAt: 1 }).lean().exec(),
            this.positionModel.find({ status: "CLOSED" }).lean().exec(),
            this.positionModel
                .find({ status: { $ne: "CLOSED" }, totalShares: { $gt: 0 } })
                .lean()
                .exec(),
            this.configModel.findOne({ key: "singleton" }).lean().exec(),
        ]);

        const targetMap = new Map<string, string>();
        for (const t of targets) {
            targetMap.set(t.address.toLowerCase(), t.alias);
        }

        const initialCapital = Number(
            configDoc?.simulatedBalanceUsdc ??
                Number(Deno.env.get("SIMULATED_BALANCE_USDC")) ??
                1000.0
        );

        const toMs = (ts: number | undefined): number => {
            const val = Number(ts || 0);
            if (val <= 0) return 0;
            return val < 100_000_000_000 ? val * 1000 : val;
        };
        const round2 = (n: number): number => Math.round(n * 100) / 100;

        type TimelineEvent =
            | { kind: "CLOSE"; timestamp: number; position: (typeof closedPositions)[number] }
            | { kind: "TRADE"; timestamp: number; trade: (typeof trades)[number] };

        const events: TimelineEvent[] = [];
        for (const pos of closedPositions) {
            const ts = toMs(pos.closedAt ?? pos.updatedAt);
            if (ts > 0) {
                events.push({ kind: "CLOSE", timestamp: ts, position: pos });
            }
        }
        for (const trade of trades) {
            const ts = toMs(trade.executedAt);
            if (ts > 0) {
                events.push({ kind: "TRADE", timestamp: ts, trade });
            }
        }

        events.sort((a, b) => {
            if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
            // Applique la clôture avant le trade au même horodatage (ex: WHALE_SELL)
            if (a.kind === b.kind) return 0;
            return a.kind === "CLOSE" ? -1 : 1;
        });

        let runningCumulativePnl = 0.0;
        let runningWhaleVolume = 0.0;

        const points: PerformancePoint[] = [];

        const firstEvent = events[0];
        const startTimestamp =
            firstEvent !== undefined ? firstEvent.timestamp - 60000 : Date.now() - 3600000;
        points.push({
            timestamp: startTimestamp,
            myCumulativePnlUsdc: 0,
            portfolioValueUsdc: round2(initialCapital),
            whaleCumulativeUsdc: 0,
        });

        for (let i = 0; i < events.length; i++) {
            const evt = events[i];
            if (!evt) continue;
            if (evt.kind === "CLOSE") {
                runningCumulativePnl += Number(evt.position.realizedPnlUsdc || 0);
                const nextEvt = events[i + 1];
                // Si un trade (ex. SELL) survient au même timestamp, il portera l'état mis à jour
                if (nextEvt && nextEvt.kind === "TRADE" && nextEvt.timestamp === evt.timestamp) {
                    continue;
                }
                const targetAddr = evt.position.targetAddress?.toLowerCase();
                const alias = targetAddr
                    ? targetMap.get(targetAddr) || targetAddr.slice(0, 8)
                    : undefined;
                points.push({
                    timestamp: evt.timestamp,
                    targetAddress: evt.position.targetAddress,
                    targetAlias: alias,
                    myCumulativePnlUsdc: round2(runningCumulativePnl),
                    portfolioValueUsdc: Math.max(0, round2(initialCapital + runningCumulativePnl)),
                    whaleCumulativeUsdc: round2(runningWhaleVolume),
                });
            } else {
                const trade = evt.trade;
                const alias =
                    targetMap.get(trade.targetAddress.toLowerCase()) ||
                    trade.targetAddress.slice(0, 8);
                runningWhaleVolume += Number(trade.costUsdc || 0);

                points.push({
                    timestamp: evt.timestamp,
                    tradeId: trade.tradeId,
                    side: trade.side,
                    shares: trade.shares,
                    price: trade.executedPrice,
                    costUsdc: trade.costUsdc,
                    targetAddress: trade.targetAddress,
                    targetAlias: alias,
                    myCumulativePnlUsdc: round2(runningCumulativePnl),
                    portfolioValueUsdc: Math.max(0, round2(initialCapital + runningCumulativePnl)),
                    whaleCumulativeUsdc: round2(runningWhaleVolume),
                });
            }
        }

        // Ancre le point final sur la valorisation live exacte (cash libre + valeur au carnet des positions ouvertes)
        const openInvested = openPositions.reduce(
            (acc, p) => acc + Number(p.totalInvestedUsdc || 0),
            0
        );
        const openCurrentValue = openPositions.reduce(
            (acc, p) => acc + Number(p.currentMarketValueUsdc || 0),
            0
        );
        const availableCash = Math.max(0, initialCapital - openInvested + runningCumulativePnl);
        const livePortfolioValue = round2(availableCash + openCurrentValue);
        const lastPoint = points[points.length - 1];

        if (
            lastPoint &&
            (events.length > 0 || openPositions.length > 0) &&
            Math.abs(livePortfolioValue - lastPoint.portfolioValueUsdc) > 0.005
        ) {
            points.push({
                timestamp: Math.max(Date.now(), lastPoint.timestamp + 1),
                myCumulativePnlUsdc: round2(runningCumulativePnl),
                portfolioValueUsdc: livePortfolioValue,
                whaleCumulativeUsdc: round2(runningWhaleVolume),
            });
        }

        return points;
    }

    async getPeriodSummary(query: PeriodSummaryQueryParsed): Promise<PeriodSummaryResponse> {
        const granularity = query.granularity;
        const timezone = resolveSafeTimeZone(query.tz);
        const dateFormat = GRANULARITY_DATE_FORMAT[granularity];
        const { page, limit, skip } = normalizePagination(query.page, query.limit, 20, 100);

        const [positionRows, tradeRows] = await Promise.all([
            this.positionModel.aggregate<PeriodPositionAggRow>([
                { $match: { status: "CLOSED" } },
                {
                    $addFields: {
                        effectiveTsMs: buildTimestampMsExpr("$closedAt", "$updatedAt"),
                    },
                },
                {
                    $addFields: {
                        periodKey: {
                            $dateToString: {
                                format: dateFormat,
                                date: { $toDate: "$effectiveTsMs" },
                                timezone,
                            },
                        },
                    },
                },
                {
                    $group: {
                        _id: "$periodKey",
                        ...CLOSED_POSITION_STATS_ACCUMULATORS,
                    },
                },
            ]),
            this.tradeModel.aggregate<PeriodTradeAggRow>([
                { $match: { status: "FILLED" } },
                {
                    $addFields: {
                        effectiveTsMs: buildTimestampMsExpr("$executedAt", "$executedAt"),
                    },
                },
                {
                    $addFields: {
                        periodKey: {
                            $dateToString: {
                                format: dateFormat,
                                date: { $toDate: "$effectiveTsMs" },
                                timezone,
                            },
                        },
                    },
                },
                {
                    $group: {
                        _id: "$periodKey",
                        tradesCount: { $sum: 1 },
                    },
                },
            ]),
        ]);

        const tradeCountMap = new Map<string, number>();
        for (const tr of tradeRows) {
            if (tr._id) {
                tradeCountMap.set(tr._id, Number(tr.tradesCount || 0));
            }
        }

        const posRowMap = new Map<string, PeriodPositionAggRow>();
        for (const pr of positionRows) {
            if (pr._id) {
                posRowMap.set(pr._id, pr);
            }
        }

        const allKeys = new Set<string>([...posRowMap.keys(), ...tradeCountMap.keys()]);

        const allPeriods: PeriodSummaryItem[] = [];
        const globalAccumulator: RawClosedStatsDoc = {
            count: 0,
            totalInvested: 0,
            totalPayout: 0,
            totalGains: 0,
            totalLosses: 0,
            netPnl: 0,
            totalShares: 0,
            winCount: 0,
            lossCount: 0,
        };

        for (const periodKey of allKeys) {
            const rawStats = posRowMap.get(periodKey);
            const formatted = formatClosedPositionsTotals(rawStats);
            const bucket = formatPeriodBucket(periodKey, granularity);

            globalAccumulator.count = (globalAccumulator.count || 0) + formatted.count;
            globalAccumulator.totalInvested =
                (globalAccumulator.totalInvested || 0) + formatted.totalInvested;
            globalAccumulator.totalPayout =
                (globalAccumulator.totalPayout || 0) + formatted.totalPayout;
            globalAccumulator.totalGains =
                (globalAccumulator.totalGains || 0) + formatted.totalGains;
            globalAccumulator.totalLosses =
                (globalAccumulator.totalLosses || 0) + formatted.totalLosses;
            globalAccumulator.netPnl = (globalAccumulator.netPnl || 0) + formatted.netPnl;
            globalAccumulator.totalShares =
                (globalAccumulator.totalShares || 0) + formatted.totalShares;
            globalAccumulator.winCount = (globalAccumulator.winCount || 0) + formatted.winCount;
            globalAccumulator.lossCount = (globalAccumulator.lossCount || 0) + formatted.lossCount;

            allPeriods.push({
                periodKey,
                periodLabel: bucket.periodLabel,
                startTimestamp: bucket.startTimestamp,
                endTimestamp: bucket.endTimestamp,
                tradesCount: tradeCountMap.get(periodKey) ?? 0,
                ...formatted,
            });
        }

        const totals = formatClosedPositionsTotals(globalAccumulator);

        let bestPeriod: PeriodSummaryItem | null = null;
        let worstPeriod: PeriodSummaryItem | null = null;
        for (const item of allPeriods) {
            if (item.count === 0) continue;
            if (!bestPeriod || item.netPnl > bestPeriod.netPnl) {
                bestPeriod = item;
            }
            if (!worstPeriod || item.netPnl < worstPeriod.netPnl) {
                worstPeriod = item;
            }
        }

        const periodsWithClosures = allPeriods.filter((p) => p.count > 0);
        const avgNetPnlPerPeriod =
            periodsWithClosures.length > 0
                ? Math.round((totals.netPnl / periodsWithClosures.length) * 100) / 100
                : 0;

        const dir = query.sortOrder === "asc" ? 1 : -1;
        allPeriods.sort((a, b) => {
            let cmp = 0;
            switch (query.sortBy) {
                case "period":
                    cmp = a.periodKey.localeCompare(b.periodKey);
                    break;
                case "count":
                    cmp = a.count - b.count;
                    break;
                case "winRate":
                    cmp = a.winRate - b.winRate;
                    break;
                case "totalInvested":
                    cmp = a.totalInvested - b.totalInvested;
                    break;
                case "netPnl":
                    cmp = a.netPnl - b.netPnl;
                    break;
                case "roiPercent":
                    cmp = a.roiPercent - b.roiPercent;
                    break;
            }
            if (cmp !== 0) return cmp * dir;
            return b.periodKey.localeCompare(a.periodKey);
        });

        const pagedItems = allPeriods.slice(skip, skip + limit);
        return buildPaginatedResponse(pagedItems, allPeriods.length, page, limit, {
            granularity,
            totals,
            bestPeriod,
            worstPeriod,
            avgNetPnlPerPeriod,
        });
    }
}
