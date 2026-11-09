import "reflect-metadata";
import { assertEquals } from "jsr:@std/assert";
import type { OpenPosition } from "@polymarket-copy/shared";
import { DiscordNotifierService } from "../src/modules/notifications/discord-notifier.service.ts";
import { PositionsService } from "../src/modules/positions/positions.service.ts";
import type { EventsGateway } from "../src/modules/gateway/events.gateway.ts";

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
    mockPositionModel as any,
    mockTargetModel as any,
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
    mockPositionModel as any,
    {} as any,
    { broadcast: () => {} } as any,
    {} as any
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
