import type { ClosedPositionsTotals } from "@lotso-trading/shared";

export interface RawClosedStatsDoc {
    totalInvested?: number;
    totalPayout?: number;
    netPnl?: number;
    totalShares?: number;
    winCount?: number;
    lossCount?: number;
    totalGains?: number;
    totalLosses?: number;
    count?: number;
}

/**
 * Expression MongoDB canonique définissant une position clôturée gagnante :
 * - résolution officielle gagnante (`RESOLVED_WIN`), OU
 * - clôture anticipée (`WHALE_SELL` / `MANUAL`) avec un PnL réalisé strictement positif.
 * Garantit que `winCount + lossCount === count` partout (Synthèse, Journal, Bilans, Cibles).
 */
export const CLOSED_WIN_EXPR = {
    $or: [{ $eq: ["$closeReason", "RESOLVED_WIN"] }, { $gt: ["$realizedPnlUsdc", 0] }],
} as const;

export const CLOSED_WIN_MATCH: Record<string, unknown> = {
    $or: [{ closeReason: "RESOLVED_WIN" }, { realizedPnlUsdc: { $gt: 0 } }],
};

export const CLOSED_LOSS_MATCH: Record<string, unknown> = {
    closeReason: { $ne: "RESOLVED_WIN" },
    $or: [{ realizedPnlUsdc: { $lte: 0 } }, { realizedPnlUsdc: { $exists: false } }],
};

/**
 * Accumulateurs MongoDB $group réutilisables pour agréger les performances des positions clôturées.
 */
export const CLOSED_POSITION_STATS_ACCUMULATORS = {
    totalInvested: { $sum: { $ifNull: ["$totalInvestedUsdc", 0] } },
    totalPayout: { $sum: { $ifNull: ["$settledPayoutUsdc", 0] } },
    netPnl: { $sum: { $ifNull: ["$realizedPnlUsdc", 0] } },
    totalShares: { $sum: { $ifNull: ["$totalShares", 0] } },
    winCount: {
        $sum: {
            $cond: [CLOSED_WIN_EXPR, 1, 0],
        },
    },
    lossCount: {
        $sum: {
            $cond: [CLOSED_WIN_EXPR, 0, 1],
        },
    },
    totalGains: {
        $sum: {
            $cond: [{ $gt: ["$realizedPnlUsdc", 0] }, "$realizedPnlUsdc", 0],
        },
    },
    totalLosses: {
        $sum: {
            $cond: [{ $lt: ["$realizedPnlUsdc", 0] }, { $abs: "$realizedPnlUsdc" }, 0],
        },
    },
    count: { $sum: 1 },
} as const;

export function formatClosedPositionsTotals(statsDoc?: RawClosedStatsDoc): ClosedPositionsTotals {
    const count = Number(statsDoc?.count || 0);
    const totalInvested = Number(statsDoc?.totalInvested || 0);
    const totalPayout = Number(statsDoc?.totalPayout || 0);
    const netPnl = Number(statsDoc?.netPnl || 0);
    const totalShares = Number(statsDoc?.totalShares || 0);
    const winCount = Number(statsDoc?.winCount || 0);
    const lossCount = Number(statsDoc?.lossCount || 0);
    const totalGains = Number(statsDoc?.totalGains || 0);
    const totalLosses = Number(statsDoc?.totalLosses || 0);

    const avgEntryPrice = totalShares > 0 ? totalInvested / totalShares : 0;
    const winRate = count > 0 ? (winCount / count) * 100 : 0;
    const roiPercent = totalInvested > 0 ? (netPnl / totalInvested) * 100 : 0;

    return {
        count,
        totalInvested: Math.round(totalInvested * 100) / 100,
        totalPayout: Math.round(totalPayout * 100) / 100,
        totalGains: Math.round(totalGains * 100) / 100,
        totalLosses: Math.round(totalLosses * 100) / 100,
        netPnl: Math.round(netPnl * 100) / 100,
        totalShares: Math.round(totalShares * 100) / 100,
        avgEntryPrice,
        winCount,
        lossCount,
        winRate: Math.round(winRate * 100) / 100,
        roiPercent: Math.round(roiPercent * 100) / 100,
    };
}

/**
 * Construit une expression MongoDB normalisant un timestamp (secondes ou ms) en millisecondes.
 */
export function buildTimestampMsExpr(
    primaryField: string,
    fallbackField = "$updatedAt"
): Record<string, unknown> {
    const rawExpr = { $ifNull: [primaryField, fallbackField] };
    return {
        $cond: [{ $lt: [rawExpr, 100_000_000_000] }, { $multiply: [rawExpr, 1000] }, rawExpr],
    };
}
