import {
  buildClosedPositionEmbed,
  buildClosedPositionsSummaryEmbed,
  type ClosedPositionsSummary,
  type OpenPosition,
  type TargetTrader,
} from "@polymarket-copy/shared";

function getEnv(key: string, defaultValue = ""): string {
  const envVal = Deno.env.get(key);
  if (envVal) return envVal;
  try {
    const envContent = Deno.readTextFileSync(".env");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (k === key) return v;
      }
    }
  } catch (_err: unknown) {
    // Pas de fichier .env
  }
  return defaultValue;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function postToDiscord(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.warn(`[Discord Error] Status ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    console.error("[Discord Exception]", err);
    return false;
  }
}

export async function run(): Promise<void> {
  const webhookUrl =
    getEnv("DISCORD_CLOSED_POSITIONS_WEBHOOK_URL") ||
    getEnv("DISCORD_SELL_WEBHOOK_URL") ||
    "https://discord.com/api/webhooks/1569215560301150221/OFRUZXn5CH8ec2i9GVphi6PMIZQfJs9WagHThPdUXIt-kehRpz0hyYG52OFCrI6tSNx5";

  const apiUrl = getEnv("API_URL", "http://localhost:3000/api");

  console.log("==================================================");
  console.log("🚀 Envoi des Positions Clôturées sur Discord");
  console.log(`📡 Webhook cible : ${webhookUrl.slice(0, 50)}...`);
  console.log(`🌐 API source : ${apiUrl}`);
  console.log("==================================================");

  // 1. Récupération des cibles pour obtenir les alias
  const targetMap = new Map<string, string>();
  try {
    const targetRes = await fetch(`${apiUrl}/targets`, { signal: AbortSignal.timeout(4000) });
    if (targetRes.ok) {
      const targetData = (await targetRes.json()) as { success: boolean; data: TargetTrader[] };
      if (Array.isArray(targetData.data)) {
        for (const t of targetData.data) {
          targetMap.set(t.address.toLowerCase(), t.alias);
        }
      }
    }
  } catch (_err: unknown) {
    console.warn("⚠️ Impossible de charger les alias des cibles, fallback adresses");
  }

  // 2. Récupération des positions clôturées
  const posRes = await fetch(`${apiUrl}/positions/closed`, { signal: AbortSignal.timeout(5000) });
  if (!posRes.ok) {
    console.error(`❌ Échec de récupération des positions clôturées : HTTP ${posRes.status}`);
    Deno.exit(1);
  }

  const json = (await posRes.json()) as { success: boolean; data: OpenPosition[] };
  const positions = json.data;

  if (!Array.isArray(positions) || positions.length === 0) {
    console.log("ℹ️ Aucune position clôturée trouvée en base de données.");
    return;
  }

  console.log(`📦 ${positions.length} positions clôturées récupérées avec succès.`);

  // 3. Calcul des statistiques globales
  let wonCount = 0;
  let lostCount = 0;
  let whaleSellCount = 0;
  let totalInvestedUsdc = 0;
  let totalPayoutUsdc = 0;
  let totalRealizedPnlUsdc = 0;

  for (const pos of positions) {
    const invested = pos.totalInvestedUsdc || 0;
    const isWin = pos.closeReason === "RESOLVED_WIN";
    const nominalWinPayout = isWin ? Math.round((pos.totalShares || 0) * 100) / 100 : undefined;
    const payout =
      nominalWinPayout !== undefined
        ? nominalWinPayout
        : pos.settledPayoutUsdc !== undefined
          ? pos.settledPayoutUsdc
          : pos.realizedPnlUsdc !== undefined
            ? Math.max(0, invested + pos.realizedPnlUsdc)
            : 0;
    const pnl =
      nominalWinPayout !== undefined
        ? nominalWinPayout - invested
        : pos.realizedPnlUsdc !== undefined
          ? pos.realizedPnlUsdc
          : payout - invested;

    totalInvestedUsdc += invested;
    totalPayoutUsdc += payout;
    totalRealizedPnlUsdc += pnl;

    if (pos.closeReason === "RESOLVED_WIN" || (pnl > 0 && !pos.closeReason?.includes("SELL"))) {
      wonCount++;
    } else if (pos.closeReason === "RESOLVED_LOSS" || (pnl < 0 && payout === 0)) {
      lostCount++;
    } else {
      whaleSellCount++;
    }
  }

  const summary: ClosedPositionsSummary = {
    totalCount: positions.length,
    wonCount,
    lostCount,
    whaleSellCount,
    totalInvestedUsdc: Math.round(totalInvestedUsdc * 100) / 100,
    totalPayoutUsdc: Math.round(totalPayoutUsdc * 100) / 100,
    totalRealizedPnlUsdc: Math.round(totalRealizedPnlUsdc * 100) / 100,
    winRatePercent: positions.length > 0 ? (wonCount / positions.length) * 100 : 0,
  };

  // 4. Envoi du Récapitulatif Global
  console.log("\n📊 [1/2] Envoi de l'embed de synthèse globale...");
  const summaryPayload = buildClosedPositionsSummaryEmbed(summary);
  const summarySent = await postToDiscord(webhookUrl, summaryPayload);
  if (summarySent) {
    console.log("✅ Synthèse globale transmise avec succès !");
  }
  await sleep(1000);

  // 5. Tri chronologique ascendant (plus ancienne vers plus récente)
  positions.sort((a, b) => {
    const timeA = a.closedAt || a.updatedAt || 0;
    const timeB = b.closedAt || b.updatedAt || 0;
    return timeA - timeB;
  });

  // 6. Envoi séquentiel avec temporisation de 500ms
  console.log(
    `\n📨 [2/2] Envoi individuel des ${positions.length} cartes de positions (délai: 500ms)...`
  );

  let successCount = 0;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (!pos) continue;

    const targetAlias = targetMap.get((pos.targetAddress || "").toLowerCase());
    const embedPayload = buildClosedPositionEmbed(pos, targetAlias);

    const sent = await postToDiscord(webhookUrl, embedPayload);
    if (sent) {
      successCount++;
      const pnl = pos.realizedPnlUsdc ?? 0;
      const sign = pnl >= 0 ? "+" : "";
      console.log(
        `  [${i + 1}/${positions.length}] ✅ ${pos.marketQuestion.slice(0, 40)}... (${sign}${pnl.toFixed(2)} USDC)`
      );
    } else {
      console.warn(
        `  [${i + 1}/${positions.length}] ❌ Échec d'envoi pour : ${pos.marketQuestion}`
      );
    }

    // Temporisation de 500ms pour respecter la limite Discord de 30 requêtes/minute
    await sleep(500);
  }

  console.log("\n==================================================");
  console.log(`🎉 Terminé ! ${successCount}/${positions.length} alertes transmises avec succès.`);
  console.log(
    `💰 PnL total notifié : ${summary.totalRealizedPnlUsdc >= 0 ? "+" : ""}${summary.totalRealizedPnlUsdc} USDC`
  );
  console.log("==================================================");
}

if (import.meta.main) {
  run().catch((err: unknown) => {
    console.error("Fatal error:", err);
    Deno.exit(1);
  });
}
