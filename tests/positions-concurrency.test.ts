import "reflect-metadata";
import { assertEquals } from "jsr:@std/assert";
import type { OpenPosition } from "@polymarket-copy/shared";
import type { Model } from "mongoose";
import type { PositionDocument } from "../src/database/schemas/position.schema.ts";
import type { TargetDocument } from "../src/database/schemas/target.schema.ts";
import type { EventsGateway } from "../src/modules/gateway/events.gateway.ts";
import { DiscordNotifierService } from "../src/modules/notifications/discord-notifier.service.ts";
import { PositionsService } from "../src/modules/positions/positions.service.ts";

Deno.test("DiscordNotifierService - déduplique et refuse les alertes multiples pour la même position", async () => {
  // Configurer une URL factice de webhook pour le test
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

    // Premier envoi -> doit passer
    await notifier.sendClosedPositionAlert(mockPosition, "RN1");
    assertEquals(fetchCallCount, 1);

    // Envois concurrents / successifs pour la même position -> doivent être bloqués par le cache de déduplication
    await notifier.sendClosedPositionAlert(mockPosition, "RN1");
    await notifier.sendClosedPositionAlert(mockPosition, "RN1");
    await notifier.sendClosedPositionAlert(mockPosition, "RN1");

    assertEquals(fetchCallCount, 1, "Les alertes doublons doivent être strictement ignorées");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("DISCORD_CLOSED_POSITIONS_WEBHOOK_URL");
  }
});

Deno.test("PositionsService - single-flight mutex mutualise les appels concurrents de settlement", async () => {
  let dbFindCount = 0;
  const mockPositionModel = {
    find: () => {
      dbFindCount++;
      return {
        exec: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve([]), 30);
          }),
      };
    },
    findOneAndUpdate: () => Promise.resolve(null),
  };

  const mockTargetModel = {
    findOne: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
  };

  const mockEventsGateway = {
    broadcast: () => {},
  } as unknown as EventsGateway;

  const mockDiscordNotifier = {
    sendClosedPositionAlert: () => Promise.resolve(),
  } as unknown as DiscordNotifierService;

  const service = new PositionsService(
    mockPositionModel as unknown as Model<PositionDocument>,
    mockTargetModel as unknown as Model<TargetDocument>,
    mockEventsGateway,
    mockDiscordNotifier
  );

  // Lancement de 5 appels concurrents avec force = true
  const results = await Promise.all([
    service.settleResolvedPositions(true),
    service.settleResolvedPositions(true),
    service.settleResolvedPositions(true),
    service.settleResolvedPositions(true),
    service.settleResolvedPositions(true),
  ]);

  // Grâce au single-flight mutex, une seule exécution réelle a été lancée
  assertEquals(dbFindCount, 1, "Une seule requête réelle en base doit être exécutée");
  assertEquals(results, [0, 0, 0, 0, 0]);
});

Deno.test("PositionsService - throttling bloque les exécutions automatiques trop rapprochées", async () => {
  let dbFindCount = 0;
  const mockPositionModel = {
    find: () => {
      dbFindCount++;
      return {
        exec: () => Promise.resolve([]),
      };
    },
  };

  const service = new PositionsService(
    mockPositionModel as unknown as Model<PositionDocument>,
    {} as unknown as Model<TargetDocument>,
    { broadcast: () => {} } as unknown as EventsGateway,
    {} as unknown as DiscordNotifierService
  );

  // Premier appel automatique -> exécuté
  const first = await service.settleResolvedPositions(false);
  assertEquals(first, 0);
  assertEquals(dbFindCount, 1);

  // Deuxième appel automatique immédiat -> bloqué par le throttling (retourne 0 sans interroger la DB)
  const second = await service.settleResolvedPositions(false);
  assertEquals(second, 0);
  assertEquals(dbFindCount, 1, "Le throttling doit empêcher l'exécution");
});

Deno.test("PositionsService - findClosedPaginated exécute l'agrégation avec pagination et calcul des totaux", async () => {
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
  };

  const service = new PositionsService(
    mockPositionModel as unknown as Model<PositionDocument>,
    {} as unknown as Model<TargetDocument>,
    { broadcast: () => {} } as unknown as EventsGateway,
    {} as unknown as DiscordNotifierService
  );

  const paginated = await service.findClosedPaginated({
    page: 2,
    limit: 25,
    status: "WIN",
  });

  assertEquals(paginated.page, 2);
  assertEquals(paginated.limit, 25);
  assertEquals(paginated.total, 55);
  assertEquals(paginated.totalPages, 3);
  assertEquals(paginated.items.length, 1);
  assertEquals(paginated.items[0]?.id, "pos_1");
  assertEquals(paginated.totals.count, 55);
  assertEquals(paginated.totals.winCount, 40);
  assertEquals(paginated.totals.lossCount, 15);
  assertEquals(paginated.totals.netPnl, 1250);
  assertEquals(paginated.totals.totalInvested, 2750);
  assertEquals(paginated.totals.totalPayout, 4000);
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
