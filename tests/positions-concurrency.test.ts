import "reflect-metadata";
import { assertEquals } from "jsr:@std/assert";
import type { OpenPosition } from "@lotso-trading/shared";
import type { Model } from "mongoose";
import type { PositionDocument } from "../src/database/schemas/position.schema.ts";
import type { TargetDocument } from "../src/database/schemas/target.schema.ts";
import type { EventsGateway } from "../src/modules/gateway/events.gateway.ts";
import { DiscordNotifierService } from "../src/modules/notifications/discord-notifier.service.ts";
import { PositionsService } from "../src/modules/positions/positions.service.ts";

Deno.test("DiscordNotifierService - déduplique et refuse les alertes multiples pour la même position", async () => {
    Deno.env.set(
        "DISCORD_CLOSED_POSITIONS_WEBHOOK_URL",
        "https://discord.com/api/webhooks/test/mock"
    );

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) => {
        fetchCallCount++;
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;

    try {
        const notifier = new DiscordNotifierService();
        const mockPosition: OpenPosition = {
            id: "pos_club_leon_test",
            conditionId: "0x3600ff94dca8fb5c158e9770a9ddea2c2808a8db7cb7339b85c6a667fe9c4b47",
            assetAddress: "0x3600ff94dca8fb5c158e9770a9ddea2c2808a8db7cb7339b85c6a667fe9c4b47",
            marketSlug: "mex-leo-gua-2026-11-08-total-3pt5",
            marketQuestion: "Club León FC vs. CD Guadalajara: O/U 3.5",
            outcomeLabel: "Under",
            status: "CLOSED",
            closeReason: "RESOLVED_WIN",
            totalShares: 59.88,
            avgEntryPrice: 0.501,
            totalInvestedUsdc: 30,
            currentMarketPrice: 1,
            currentMarketValueUsdc: 59.88,
            unrealizedPnlUsdc: 0,
            unrealizedPnlPercent: 0,
            targetAddress: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
            openedAt: Date.now() - 60000,
            updatedAt: Date.now(),
        };

        await notifier.sendClosedPositionAlert(mockPosition, "RN1");
        assertEquals(fetchCallCount, 1);

        await notifier.sendClosedPositionAlert(mockPosition, "RN1");
        await notifier.sendClosedPositionAlert(mockPosition, "RN1");
        await notifier.sendClosedPositionAlert(mockPosition, "RN1");

        assertEquals(fetchCallCount, 1, "Les alertes doublons doivent être strictement ignorées");
    } finally {
        globalThis.fetch = originalFetch;
        Deno.env.delete("DISCORD_CLOSED_POSITIONS_WEBHOOK_URL");
    }
});

Deno.test("PositionsService - requestPositionSync délègue au bot via WebSocket sans appeler Polymarket", () => {
    let sentEvent = "";
    const mockGatewayOnline = {
        isBotConnected: () => true,
        sendToBots: (event: string) => {
            sentEvent = event;
            return true;
        },
        broadcast: () => {},
    } as unknown as EventsGateway;

    const serviceOnline = new PositionsService(
        {} as unknown as Model<PositionDocument>,
        {} as unknown as Model<TargetDocument>,
        mockGatewayOnline,
        {} as unknown as DiscordNotifierService
    );

    const resOnline = serviceOnline.requestPositionSync();
    assertEquals(resOnline.requested, true);
    assertEquals(resOnline.botOnline, true);
    assertEquals(sentEvent, "bot:check-resolutions");

    const mockGatewayOffline = {
        isBotConnected: () => false,
        sendToBots: () => false,
        broadcast: () => {},
    } as unknown as EventsGateway;

    const serviceOffline = new PositionsService(
        {} as unknown as Model<PositionDocument>,
        {} as unknown as Model<TargetDocument>,
        mockGatewayOffline,
        {} as unknown as DiscordNotifierService
    );

    const resOffline = serviceOffline.requestPositionSync();
    assertEquals(resOffline.requested, false);
    assertEquals(resOffline.botOnline, false);
});

Deno.test("PositionsService - closePosition persiste de manière atomique, met à jour les stats et diffuse position:closed", async () => {
    let alreadyClosed = false;
    let broadcastCount = 0;
    let discordAlertCount = 0;
    let targetUpdated = false;

    const mockPos = {
        _id: "pos_atomic_test",
        positionId: "pos_atomic_test",
        conditionId: "0x9876543210abcdef9876543210abcdef9876543210abcdef9876543210abcdef",
        assetAddress: "0x1111111111111111111111111111111111111111",
        marketSlug: "slug-worldcup",
        marketQuestion: "France vs Brazil?",
        outcomeLabel: "France",
        status: "OPEN",
        totalShares: 100,
        avgEntryPrice: 0.5,
        totalInvestedUsdc: 50,
        currentMarketPrice: 0.5,
        currentMarketValueUsdc: 50,
        unrealizedPnlUsdc: 0,
        unrealizedPnlPercent: 0,
        targetAddress: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
        openedAt: 1730000000000,
        updatedAt: 1730000000000,
    };

    const mockPositionModel = {
        findOne: () => Promise.resolve(alreadyClosed ? null : mockPos),
        findOneAndUpdate: (_filter: unknown, update: { $set: Record<string, unknown> }) => {
            if (alreadyClosed) return Promise.resolve(null);
            alreadyClosed = true;
            return Promise.resolve({
                ...mockPos,
                ...update.$set,
                toObject: () => ({ ...mockPos, ...update.$set }),
            });
        },
    };

    const mockTargetModel = {
        findOne: () => ({ lean: () => ({ exec: () => Promise.resolve({ alias: "RN1" }) }) }),
        updateOne: () => {
            targetUpdated = true;
            return Promise.resolve({ modifiedCount: 1 });
        },
    };

    const mockGateway = {
        broadcast: (event: string) => {
            if (event === "position:closed") broadcastCount++;
        },
    } as unknown as EventsGateway;

    const mockNotifier = {
        sendClosedPositionAlert: () => {
            discordAlertCount++;
            return Promise.resolve();
        },
    } as unknown as DiscordNotifierService;

    const service = new PositionsService(
        mockPositionModel as unknown as Model<PositionDocument>,
        mockTargetModel as unknown as Model<TargetDocument>,
        mockGateway,
        mockNotifier
    );

    const first = await service.closePosition(mockPos.conditionId, {
        closeReason: "RESOLVED_WIN",
        winningOutcome: "France",
    });
    const second = await service.closePosition(mockPos.conditionId, {
        closeReason: "RESOLVED_WIN",
        winningOutcome: "France",
    });

    assertEquals(first?.status, "CLOSED");
    assertEquals(first?.settledPayoutUsdc, 100);
    assertEquals(first?.realizedPnlUsdc, 50);
    assertEquals(second, null);
    assertEquals(broadcastCount, 1);
    assertEquals(discordAlertCount, 1);
    assertEquals(targetUpdated, true);
});

Deno.test("PositionsService - getClosedSummary agrège toutes les positions clôturées sans limite de 100", async () => {
    const mockPositionModel = {
        aggregate: () =>
            Promise.resolve([
                {
                    _id: null,
                    count: 240,
                    totalInvested: 12000,
                    totalPayout: 15600,
                    netPnl: 3600,
                    totalShares: 15600,
                    winCount: 180,
                    lossCount: 60,
                    totalGains: 5100,
                    totalLosses: 1500,
                },
            ]),
    };

    const service = new PositionsService(
        mockPositionModel as unknown as Model<PositionDocument>,
        {} as unknown as Model<TargetDocument>,
        { broadcast: () => {} } as unknown as EventsGateway,
        {} as unknown as DiscordNotifierService
    );

    const summary = await service.getClosedSummary();
    assertEquals(summary.count, 240);
    assertEquals(summary.winCount, 180);
    assertEquals(summary.lossCount, 60);
    assertEquals(summary.netPnl, 3600);
    assertEquals(summary.winRate, 75);
    assertEquals(summary.roiPercent, 30);
});

Deno.test("PositionsService - findClosedPaginated exécute l'agrégation avec pagination (20 par défaut) et totaux", async () => {
    const mockAggregationResult = [
        {
            items: [
                {
                    _id: "pos_1",
                    conditionId: "0xcond1",
                    assetAddress: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
                    marketSlug: "slug-1",
                    marketQuestion: "Question 1?",
                    outcomeLabel: "Yes",
                    status: "CLOSED",
                    closeReason: "RESOLVED_WIN",
                    totalShares: 100,
                    avgEntryPrice: 0.5,
                    totalInvestedUsdc: 50,
                    settledPayoutUsdc: 100,
                    realizedPnlUsdc: 50,
                    currentMarketPrice: 1,
                    currentMarketValueUsdc: 100,
                    unrealizedPnlUsdc: 0,
                    unrealizedPnlPercent: 0,
                    targetAddress: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
                    openedAt: 1730000000000,
                    updatedAt: 1730001000000,
                    closedAt: 1730001000000,
                },
            ],
            stats: [
                {
                    _id: null,
                    count: 55,
                    totalInvested: 2750,
                    totalPayout: 4000,
                    netPnl: 1250,
                    totalShares: 4000,
                    winCount: 40,
                    lossCount: 15,
                    totalGains: 1500,
                    totalLosses: 250,
                },
            ],
        },
    ];

    const mockPositionModel = {
        aggregate: (pipeline: unknown[]) => {
            assertEquals(Array.isArray(pipeline), true);
            return Promise.resolve(mockAggregationResult);
        },
        updateOne: () => Promise.resolve({ modifiedCount: 1 }),
    };

    const service = new PositionsService(
        mockPositionModel as unknown as Model<PositionDocument>,
        {} as unknown as Model<TargetDocument>,
        { broadcast: () => {} } as unknown as EventsGateway,
        {} as unknown as DiscordNotifierService
    );

    const paginated = await service.findClosedPaginated({
        page: 2,
        limit: 20,
        status: "WIN",
    });

    assertEquals(paginated.page, 2);
    assertEquals(paginated.limit, 20);
    assertEquals(paginated.total, 55);
    assertEquals(paginated.totalPages, 3);
    assertEquals(paginated.items.length, 1);
    assertEquals(paginated.items[0]?.id, "pos_1");
    assertEquals(paginated.totals.count, 55);
    assertEquals(paginated.totals.winCount, 40);
    assertEquals(paginated.totals.lossCount, 15);
    assertEquals(paginated.totals.netPnl, 1250);
});

Deno.test("PositionsService - findUnredeemedWinningPositions filtre les positions gagnantes sans tx de rachat", async () => {
    let filterCaptured: unknown = null;
    const mockPositionModel = {
        find: (filter: unknown) => {
            filterCaptured = filter;
            return {
                sort: () => ({
                    lean: () => ({
                        exec: () =>
                            Promise.resolve([
                                {
                                    positionId: "pos_win_unredeemed",
                                    conditionId: "0xwin1",
                                    assetAddress: "0x1111111111111111111111111111111111111111",
                                    marketSlug: "slug-win",
                                    marketQuestion: "Will it rain?",
                                    outcomeLabel: "Yes",
                                    status: "CLOSED",
                                    closeReason: "RESOLVED_WIN",
                                    settledPayoutUsdc: 25.0,
                                    totalShares: 25.0,
                                    avgEntryPrice: 0.4,
                                    totalInvestedUsdc: 10.0,
                                    currentMarketPrice: 1.0,
                                    currentMarketValueUsdc: 25.0,
                                    unrealizedPnlUsdc: 0,
                                    unrealizedPnlPercent: 0,
                                    targetAddress: "0x2222222222222222222222222222222222222222",
                                    openedAt: Date.now() - 100000,
                                    updatedAt: Date.now(),
                                },
                            ]),
                    }),
                }),
            };
        },
    };

    const service = new PositionsService(
        mockPositionModel as unknown as Model<PositionDocument>,
        {} as unknown as Model<TargetDocument>,
        { broadcast: () => {} } as unknown as EventsGateway,
        {} as unknown as DiscordNotifierService
    );

    const unredeemed = await service.findUnredeemedWinningPositions();

    assertEquals(unredeemed.length, 1);
    assertEquals(unredeemed[0]?.conditionId, "0xwin1");
    assertEquals(unredeemed[0]?.settledPayoutUsdc, 25.0);
    assertEquals(filterCaptured !== null, true);
});

Deno.test("PositionsService - recordPositionRedeemed enregistre la tx et diffuse l'événement", async () => {
    let broadcastEvent = "";
    let broadcastPayload: unknown = null;

    const mockPositionModel = {
        findOneAndUpdate: (_filter: unknown, update: { $set: { settleTxHash: string } }) => {
            return {
                lean: () => ({
                    exec: () =>
                        Promise.resolve({
                            positionId: "pos_win_1",
                            conditionId: "0xwin1",
                            assetAddress: "0x1111111111111111111111111111111111111111",
                            marketSlug: "slug-win",
                            marketQuestion: "Will it rain?",
                            outcomeLabel: "Yes",
                            status: "CLOSED",
                            closeReason: "RESOLVED_WIN",
                            settledPayoutUsdc: 50.0,
                            settleTxHash: update.$set.settleTxHash,
                            totalShares: 50.0,
                            avgEntryPrice: 0.5,
                            totalInvestedUsdc: 25.0,
                            currentMarketPrice: 1.0,
                            currentMarketValueUsdc: 50.0,
                            unrealizedPnlUsdc: 0,
                            unrealizedPnlPercent: 0,
                            targetAddress: "0x2222222222222222222222222222222222222222",
                            openedAt: Date.now() - 100000,
                            updatedAt: Date.now(),
                        }),
                }),
            };
        },
    };

    const mockGateway = {
        broadcast: (event: string, payload: unknown) => {
            broadcastEvent = event;
            broadcastPayload = payload;
        },
    } as unknown as EventsGateway;

    const service = new PositionsService(
        mockPositionModel as unknown as Model<PositionDocument>,
        {} as unknown as Model<TargetDocument>,
        mockGateway,
        {} as unknown as DiscordNotifierService
    );

    const updated = await service.recordPositionRedeemed("0xwin1", "0xreal_tx_hash_12345");

    assertEquals(updated.settleTxHash, "0xreal_tx_hash_12345");
    assertEquals(broadcastEvent, "position:redeemed");
    assertEquals((broadcastPayload as { txHash: string }).txHash, "0xreal_tx_hash_12345");
});

Deno.test("PositionsService - resolveMarketEndDate résout la date via Gamma API fallback", async () => {
    const originalFetch = globalThis.fetch;
    const mockConditionId = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    let fetchCount = 0;

    globalThis.fetch = ((url: string | URL | Request) => {
        fetchCount++;
        const urlStr = String(url);
        if (urlStr.includes("clob.polymarket.com")) {
            return Promise.resolve(new Response("Not Found", { status: 404 }));
        }
        if (urlStr.includes("gamma-api.polymarket.com/markets?condition_ids=")) {
            return Promise.resolve(
                new Response(
                    JSON.stringify([
                        {
                            conditionId: mockConditionId,
                            endDate: "2026-11-20T18:00:00Z",
                            endDateIso: "2026-11-20T18:00:00Z",
                            events: [{ slug: "test-event" }],
                        },
                    ]),
                    { status: 200 }
                )
            );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof fetch;

    try {
        const service = new PositionsService(
            {} as unknown as Model<PositionDocument>,
            {} as unknown as Model<TargetDocument>,
            { broadcast: () => {} } as unknown as EventsGateway,
            {} as unknown as DiscordNotifierService
        );

        const resolved = await service.resolveMarketEndDate(mockConditionId, "test-market");
        assertEquals(resolved, "2026-11-20T18:00:00Z");

        const cached = await service.resolveMarketEndDate(mockConditionId, "test-market");
        assertEquals(cached, "2026-11-20T18:00:00Z");
        assertEquals(fetchCount, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test("PositionsService - resolveMarketMetadata ignore un premier résultat Gamma non correspondant", async () => {
    const originalFetch = globalThis.fetch;
    const targetConditionId = "0x8a42bb4cb9b9f157b539611f6a8c122388f652570cfc3c07d538e7df2bb78894";
    let gammaQueriedUrl = "";

    globalThis.fetch = ((url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("clob.polymarket.com")) {
            return Promise.resolve(new Response("Not Found", { status: 404 }));
        }
        if (urlStr.includes("gamma-api.polymarket.com")) {
            gammaQueriedUrl = urlStr;
            return Promise.resolve(
                new Response(
                    JSON.stringify([
                        {
                            conditionId:
                                "0xa467b14d51f01b957109d9cbb1d6c124fab2a089d52ed8f471d23c2812e743b7",
                            slug: "xi-jinping-out-before-2027",
                            events: [{ slug: "xi-jinping-out-before-2027" }],
                        },
                        {
                            conditionId: targetConditionId,
                            slug: "will-ulf-kristersson-be-the-next-prime-minister-of-sweden",
                            endDate: "2026-09-14T03:59:00Z",
                            events: [{ slug: "next-prime-minister-of-sweden" }],
                        },
                    ]),
                    { status: 200 }
                )
            );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof fetch;

    try {
        const service = new PositionsService(
            {} as unknown as Model<PositionDocument>,
            {} as unknown as Model<TargetDocument>,
            { broadcast: () => {} } as unknown as EventsGateway,
            {} as unknown as DiscordNotifierService
        );

        const meta = await service.resolveMarketMetadata(targetConditionId);
        assertEquals(gammaQueriedUrl.includes("condition_ids="), true);
        assertEquals(meta.eventSlug, "next-prime-minister-of-sweden");
        assertEquals(meta.endDate, "2026-09-14T03:59:00Z");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test("PositionsService - sanitizeCorruptedEventSlugs supprime xi-jinping-out-before-2027 sur les marchés non Xi", async () => {
    let updateFilter: unknown = null;
    let updateOp: unknown = null;

    const mockPositionModel = {
        updateMany: (filter: unknown, update: unknown) => {
            updateFilter = filter;
            updateOp = update;
            return Promise.resolve({ modifiedCount: 3 });
        },
    };

    const service = new PositionsService(
        mockPositionModel as unknown as Model<PositionDocument>,
        {} as unknown as Model<TargetDocument>,
        { broadcast: () => {} } as unknown as EventsGateway,
        {} as unknown as DiscordNotifierService
    );

    const count = await service.sanitizeCorruptedEventSlugs();
    assertEquals(count, 3);
    assertEquals((updateFilter as { eventSlug: string }).eventSlug, "xi-jinping-out-before-2027");
    assertEquals((updateOp as { $unset: { eventSlug: string } }).$unset.eventSlug, "");
});
