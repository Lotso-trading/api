import "reflect-metadata";
import { assertEquals } from "jsr:@std/assert";
import type { Model } from "mongoose";
import {
    CLOSED_LOSS_MATCH,
    CLOSED_POSITION_STATS_ACCUMULATORS,
    CLOSED_WIN_EXPR,
    CLOSED_WIN_MATCH,
} from "../src/common/utils/position-stats.util.ts";
import type { ConfigDocument } from "../src/database/schemas/config.schema.ts";
import type { PositionDocument } from "../src/database/schemas/position.schema.ts";
import type { TargetDocument } from "../src/database/schemas/target.schema.ts";
import type { TradeDocument } from "../src/database/schemas/trade.schema.ts";
import type { EventsGateway } from "../src/modules/gateway/events.gateway.ts";
import { MetricsService } from "../src/modules/metrics/metrics.service.ts";
import type { PositionsService } from "../src/modules/positions/positions.service.ts";
import { SystemService } from "../src/modules/system/system.service.ts";
import { TargetsService } from "../src/modules/targets/targets.service.ts";
import { TradesService } from "../src/modules/trades/trades.service.ts";

Deno.test("TargetsService - update gère maxUsdcPerTrade=null via $unset et préserve les stats", async () => {
    let capturedUpdate: Record<string, unknown> = {};
    const mockTargetModel = {
        findByIdAndUpdate: (_id: string, update: Record<string, unknown>) => {
            capturedUpdate = update;
            return {
                lean: () => ({
                    exec: () =>
                        Promise.resolve({
                            _id: "target_1",
                            address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
                            alias: "RN1 Updated",
                            enabled: true,
                            weightMultiplier: 1.5,
                            stats: {
                                totalCopiedTrades: 12,
                                totalCopiedVolumeUsdc: 350,
                                realizedPnlUsdc: 0,
                                winRatePercent: 0,
                            },
                        }),
                }),
            };
        },
    };

    const mockPositionModel = {
        aggregate: () =>
            Promise.resolve([
                {
                    _id: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
                    realizedPnlUsdc: 145.5,
                    wonTrades: 9,
                    lostTrades: 3,
                },
            ]),
    };

    const service = new TargetsService(
        mockTargetModel as unknown as Model<TargetDocument>,
        mockPositionModel as unknown as Model<PositionDocument>,
        { broadcast: () => {} } as unknown as EventsGateway
    );

    const updated = await service.update("target_1", {
        alias: "RN1 Updated",
        weightMultiplier: 1.5,
        maxUsdcPerTrade: null,
    });

    assertEquals(capturedUpdate.$unset, { maxUsdcPerTrade: "" });
    assertEquals(updated.maxUsdcPerTrade, undefined);
    assertEquals(updated.alias, "RN1 Updated");
    assertEquals(updated.stats.wonTrades, 9);
    assertEquals(updated.stats.lostTrades, 3);
    assertEquals(updated.stats.winRatePercent, 75);
    assertEquals(updated.stats.realizedPnlUsdc, 145.5);
});

Deno.test("TradesService - findAll applique filtres avancés, recherche, tri et pagination 20/page", async () => {
    let capturedFilter: Record<string, unknown> = {};
    let capturedSort: Record<string, number> = {};
    let capturedSkip = -1;
    let capturedLimit = -1;

    const mockTradeModel = {
        find: (filter: Record<string, unknown>) => {
            capturedFilter = filter;
            return {
                sort: (sort: Record<string, number>) => {
                    capturedSort = sort;
                    return {
                        skip: (skip: number) => {
                            capturedSkip = skip;
                            return {
                                limit: (limit: number) => {
                                    capturedLimit = limit;
                                    return {
                                        lean: () => ({
                                            exec: () => Promise.resolve([]),
                                        }),
                                    };
                                },
                            };
                        },
                    };
                },
            };
        },
        countDocuments: () => ({ exec: () => Promise.resolve(45) }),
    };

    const service = new TradesService(
        mockTradeModel as unknown as Model<TradeDocument>,
        {} as unknown as Model<TargetDocument>,
        {} as unknown as PositionsService,
        { broadcast: () => {} } as unknown as EventsGateway
    );

    const res = await service.findAll({
        page: 2,
        limit: 20,
        status: "FILLED",
        side: "BUY",
        isDryRun: "DRY_RUN",
        search: "Bitcoin",
        sortBy: "costUsdc",
        sortOrder: "asc",
    });

    assertEquals(capturedFilter.status, "FILLED");
    assertEquals(capturedFilter.side, "BUY");
    assertEquals(capturedFilter.isDryRun, true);
    assertEquals(Array.isArray(capturedFilter.$or), true);
    assertEquals(capturedSort.costUsdc, 1);
    assertEquals(capturedSkip, 20);
    assertEquals(capturedLimit, 20);
    assertEquals(res.total, 45);
    assertEquals(res.totalPages, 3);
});

Deno.test("MetricsService - getPeriodSummary agrège par période, trie et calcule best/worst/moyenne", async () => {
    const mockPositionModel = {
        aggregate: () =>
            Promise.resolve([
                {
                    _id: "2026-11-18",
                    count: 4,
                    totalInvested: 100,
                    totalPayout: 140,
                    netPnl: 40,
                    totalShares: 140,
                    winCount: 3,
                    lossCount: 1,
                    totalGains: 60,
                    totalLosses: 20,
                },
                {
                    _id: "2026-11-19",
                    count: 2,
                    totalInvested: 50,
                    totalPayout: 20,
                    netPnl: -30,
                    totalShares: 20,
                    winCount: 1,
                    lossCount: 1,
                    totalGains: 10,
                    totalLosses: 40,
                },
            ]),
    };

    const mockTradeModel = {
        aggregate: () =>
            Promise.resolve([
                { _id: "2026-11-18", tradesCount: 8 },
                { _id: "2026-11-19", tradesCount: 3 },
            ]),
    };

    const service = new MetricsService(
        mockTradeModel as unknown as Model<TradeDocument>,
        mockPositionModel as unknown as Model<PositionDocument>,
        {} as unknown as Model<TargetDocument>,
        {} as unknown as Model<ConfigDocument>,
        { broadcast: () => {} } as unknown as EventsGateway
    );

    const summary = await service.getPeriodSummary({
        granularity: "day",
        page: 1,
        limit: 20,
        sortBy: "netPnl",
        sortOrder: "desc",
        tz: "Europe/Paris",
    });

    assertEquals(summary.total, 2);
    assertEquals(summary.items[0]?.periodKey, "2026-11-18");
    assertEquals(summary.items[0]?.tradesCount, 8);
    assertEquals(summary.items[1]?.periodKey, "2026-11-19");
    assertEquals(summary.bestPeriod?.periodKey, "2026-11-18");
    assertEquals(summary.worstPeriod?.periodKey, "2026-11-19");
    assertEquals(summary.totals.netPnl, 10);
    assertEquals(summary.avgNetPnlPerPeriod, 5);
});

Deno.test("SystemService - expose les versions de api, bot et shared", () => {
    const mockGateway = {
        onBotPresenceChange: () => {},
        onBotVersionChange: () => {},
        getBotVersion: () => "1.2.3",
        isBotConnected: () => true,
        broadcast: () => {},
    } as unknown as EventsGateway;

    const systemService = new SystemService(mockGateway);
    const versions = systemService.getVersions();

    assertEquals(typeof versions.api, "string");
    assertEquals(versions.api.length > 0, true);
    assertEquals(versions.bot, "1.2.3");
    assertEquals(typeof versions.shared, "string");
    assertEquals(versions.shared.length > 0, true);
    assertEquals(versions.botOnline, true);
});

Deno.test("MetricsService - getPerformanceHistory réconcilie PnL réalisé + valeur live du portefeuille", async () => {
    const mockTargetModel = {
        find: () => ({
            lean: () => ({
                exec: () =>
                    Promise.resolve([
                        { address: "0x1111111111111111111111111111111111111111", alias: "Theo4" },
                    ]),
            }),
        }),
    };

    const mockTradeModel = {
        find: () => ({
            sort: () => ({
                lean: () => ({
                    exec: () =>
                        Promise.resolve([
                            {
                                tradeId: "tr-1",
                                targetAddress: "0x1111111111111111111111111111111111111111",
                                side: "BUY",
                                shares: 200,
                                executedPrice: 0.5,
                                costUsdc: 100,
                                executedAt: 1700000100000,
                            },
                            {
                                tradeId: "tr-2",
                                targetAddress: "0x1111111111111111111111111111111111111111",
                                side: "BUY",
                                shares: 100,
                                executedPrice: 0.6,
                                costUsdc: 60,
                                executedAt: 1700000300000,
                            },
                        ]),
                }),
            }),
        }),
    };

    const mockPositionModel = {
        find: (filter: Record<string, unknown>) => ({
            lean: () => ({
                exec: () => {
                    if (filter.status === "CLOSED") {
                        return Promise.resolve([
                            {
                                targetAddress: "0x1111111111111111111111111111111111111111",
                                realizedPnlUsdc: 100,
                                closedAt: 1700000200000,
                            },
                        ]);
                    }
                    // Open position with +15$ unrealized PnL (60 invested -> 75 current value)
                    return Promise.resolve([
                        {
                            totalInvestedUsdc: 60,
                            currentMarketValueUsdc: 75,
                            unrealizedPnlUsdc: 15,
                        },
                    ]);
                },
            }),
        }),
    };

    const mockConfigModel = {
        findOne: () => ({
            lean: () => ({
                exec: () => Promise.resolve({ simulatedBalanceUsdc: 2500 }),
            }),
        }),
    };

    const service = new MetricsService(
        mockTradeModel as unknown as Model<TradeDocument>,
        mockPositionModel as unknown as Model<PositionDocument>,
        mockTargetModel as unknown as Model<TargetDocument>,
        mockConfigModel as unknown as Model<ConfigDocument>,
        { broadcast: () => {} } as unknown as EventsGateway
    );

    const history = await service.getPerformanceHistory();
    const first = history[0];
    const last = history[history.length - 1];

    // Départ à 2500$, +100$ réalisés + 15$ latents = 2615$ en fin de courbe
    assertEquals(first?.portfolioValueUsdc, 2500);
    assertEquals(first?.myCumulativePnlUsdc, 0);
    assertEquals(last?.myCumulativePnlUsdc, 100);
    assertEquals(last?.portfolioValueUsdc, 2615);
    assertEquals(last?.whaleCumulativeUsdc, 160);
});

Deno.test("position-stats.util - harmonise les règles W/L pour RESOLVED_WIN, WHALE_SELL et MANUAL", () => {
    assertEquals(CLOSED_POSITION_STATS_ACCUMULATORS.winCount.$sum.$cond[0], CLOSED_WIN_EXPR);
    assertEquals(CLOSED_POSITION_STATS_ACCUMULATORS.lossCount.$sum.$cond[0], CLOSED_WIN_EXPR);
    assertEquals(Array.isArray(CLOSED_WIN_MATCH.$or), true);
    assertEquals(CLOSED_LOSS_MATCH.closeReason, { $ne: "RESOLVED_WIN" });
});
