import {
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { ClosedPositionsQuery, ExecutedTrade, OpenPosition } from "@polymarket-copy/shared";
import type { Model } from "mongoose";
import { type PositionDocument, PositionModel } from "../../database/schemas/position.schema.ts";
import { type TargetDocument, TargetModel } from "../../database/schemas/target.schema.ts";
import { EventsGateway } from "../gateway/events.gateway.ts";
import { DiscordNotifierService } from "../notifications/discord-notifier.service.ts";

@Injectable()
export class PositionsService implements OnModuleInit, OnModuleDestroy {
  private readonly marketEndDateCache = new Map<string, { date: string; timestamp: number }>();
  private settlePromise: Promise<number> | null = null;
  private lastAutoSettleTimestamp = 0;
  private readonly autoSettleThrottleMs = 30_000; // Throttling 30s entre deux vérifications automatiques
  private autoSettleIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectModel(PositionModel.name)
    private readonly positionModel: Model<PositionDocument>,
    @InjectModel(TargetModel.name)
    private readonly targetModel: Model<TargetDocument>,
    private readonly eventsGateway: EventsGateway,
    private readonly discordNotifier: DiscordNotifierService
  ) {}

  onModuleInit(): void {
    // Vérification périodique de résolution automatique toutes les 60s en arrière-plan
    this.autoSettleIntervalId = setInterval(() => {
      this.settleResolvedPositions(false).catch((err: unknown) => {
        console.warn("[PositionsService] Erreur lors de la vérification de settlement automatique:", err);
      });
    }, 60_000);

    // Lancement en tâche de fond de la rétro-résolution des dates d'échéance manquantes
    this.backfillMissingEndDates().catch((err: unknown) => {
      console.warn("[PositionsService] Erreur backfill dates:", err);
    });
  }

  onModuleDestroy(): void {
    if (this.autoSettleIntervalId !== null) {
      clearInterval(this.autoSettleIntervalId);
      this.autoSettleIntervalId = null;
    }
  }

  private async backfillMissingEndDates(): Promise<void> {
    try {
      const positionsWithoutDate = await this.positionModel
        .find({
          $or: [{ endDate: { $exists: false } }, { endDate: "" }, { endDate: null }],
          conditionId: { $ne: "0x" },
        })
        .limit(200)
        .exec();

      if (positionsWithoutDate.length === 0) return;

      console.log(
        `[PositionsService] 🔄 Début de la rétro-résolution des dates pour ${positionsWithoutDate.length} position(s)...`
      );

      let resolvedCount = 0;
      for (const pos of positionsWithoutDate) {
        const resolved = await this.resolveMarketEndDate(
          pos.conditionId,
          pos.marketSlug,
          pos.assetAddress
        );
        if (resolved) {
          await this.positionModel.updateOne(
            { _id: pos._id },
            { $set: { endDate: resolved } }
          );
          resolvedCount++;
        }
      }

      console.log(
        `[PositionsService] ✅ Rétro-résolution terminée : ${resolvedCount}/${positionsWithoutDate.length} date(s) mise(s) à jour en base.`
      );
    } catch (err: unknown) {
      console.warn("[PositionsService] Erreur lors de la rétro-résolution des dates:", err);
    }
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

  async resolveMarketEndDate(
    conditionId: string,
    marketSlug?: string,
    assetAddress?: string
  ): Promise<string | undefined> {
    if (!conditionId || conditionId === "0x") return undefined;

    const cached = this.marketEndDateCache.get(conditionId);
    if (cached) {
      // Date trouvée : mise en cache permanente
      if (cached.date) {
        return cached.date;
      }
      // Échec temporaire : ne ré-interroger qu'après 5 minutes (TTL 300s)
      if (Date.now() - cached.timestamp < 300_000) {
        return undefined;
      }
    }

    const isHexConditionId = conditionId.startsWith("0x") && conditionId.length >= 64;
    const isTokenIdDecimal = !isHexConditionId && /^\d+$/.test(conditionId);

    // 1. Appel CLOB API
    try {
      const clobUrl = isTokenIdDecimal
        ? `https://clob.polymarket.com/markets?token_id=${conditionId}`
        : `https://clob.polymarket.com/markets/${conditionId}`;

      const res = await fetch(clobUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const json = await res.json();
        const data = (Array.isArray(json?.data) ? json.data[0] : json?.data || json) as {
          end_date_iso?: string;
          game_start_time?: string;
          endDate?: string;
        };
        const resolved = data?.end_date_iso || data?.game_start_time || data?.endDate;
        if (resolved) {
          this.marketEndDateCache.set(conditionId, { date: resolved, timestamp: Date.now() });
          return resolved;
        }
      }
    } catch (_err: unknown) {
      // Poursuite vers Gamma
    }

    // 2. Appel Gamma API par condition_id
    if (isHexConditionId) {
      try {
        const res = await fetch(
          `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) {
          const list = (await res.json()) as Array<{
            endDate?: string;
            endDateIso?: string;
            game_start_time?: string;
          }>;
          const resolved = list[0]?.endDate || list[0]?.endDateIso || list[0]?.game_start_time;
          if (resolved) {
            this.marketEndDateCache.set(conditionId, { date: resolved, timestamp: Date.now() });
            return resolved;
          }
        }
      } catch (_err: unknown) {
        // Poursuite vers Token ID / Slug
      }
    }

    // 3. Appel Gamma API par Token ID (si conditionId ou assetAddress est un token ID décimal)
    const effectiveTokenId = isTokenIdDecimal
      ? conditionId
      : assetAddress && /^\d+$/.test(assetAddress)
        ? assetAddress
        : null;

    if (effectiveTokenId) {
      try {
        const res = await fetch(
          `https://gamma-api.polymarket.com/markets?clob_token_ids=${effectiveTokenId}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) {
          const list = (await res.json()) as Array<{
            endDate?: string;
            endDateIso?: string;
            game_start_time?: string;
          }>;
          const resolved = list[0]?.endDate || list[0]?.endDateIso || list[0]?.game_start_time;
          if (resolved) {
            this.marketEndDateCache.set(conditionId, { date: resolved, timestamp: Date.now() });
            return resolved;
          }
        }
      } catch (_err: unknown) {
        // Poursuite vers Slug
      }
    }

    // 4. Appel Gamma API par slug (Events puis Markets)
    if (
      marketSlug &&
      marketSlug !== "market" &&
      marketSlug !== "polymarket-market" &&
      marketSlug !== "polygon-onchain"
    ) {
      // 4.1 Test sur /events?slug= (très fréquent pour sports et tournois)
      try {
        const eventRes = await fetch(
          `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(marketSlug)}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (eventRes.ok) {
          const eventList = (await eventRes.json()) as Array<{
            endDate?: string;
            endDateIso?: string;
            markets?: Array<{ endDate?: string; endDateIso?: string }>;
          }>;
          const ev = eventList[0];
          const resolved =
            ev?.endDate || ev?.endDateIso || ev?.markets?.[0]?.endDate || ev?.markets?.[0]?.endDateIso;
          if (resolved) {
            this.marketEndDateCache.set(conditionId, { date: resolved, timestamp: Date.now() });
            return resolved;
          }
        }
      } catch (_err: unknown) {
        // Ignoré
      }

      // 4.2 Test sur /markets?slug=
      try {
        const marketRes = await fetch(
          `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (marketRes.ok) {
          const marketList = (await marketRes.json()) as Array<{
            endDate?: string;
            endDateIso?: string;
          }>;
          const resolved = marketList[0]?.endDate || marketList[0]?.endDateIso;
          if (resolved) {
            this.marketEndDateCache.set(conditionId, { date: resolved, timestamp: Date.now() });
            return resolved;
          }
        }
      } catch (_err: unknown) {
        // Ignoré
      }
    }

    // Cache négatif temporaire (5 min) pour éviter le spam réseau sans bloquer ad vitam
    this.marketEndDateCache.set(conditionId, { date: "", timestamp: Date.now() });
    return undefined;
  }

  async settleResolvedPositions(force = false): Promise<number> {
    const now = Date.now();
    // Si ce n'est pas un appel forcé (ex: clic utilisateur), on applique le throttling
    if (!force && now - this.lastAutoSettleTimestamp < this.autoSettleThrottleMs) {
      return 0;
    }

    // Single-Flight : si une exécution est déjà en cours, partager la promesse en vol
    if (this.settlePromise) {
      return await this.settlePromise;
    }

    this.lastAutoSettleTimestamp = now;
    this.settlePromise = this.executeSettleResolvedPositions().finally(() => {
      this.settlePromise = null;
    });

    return await this.settlePromise;
  }

  private async executeSettleResolvedPositions(): Promise<number> {
    const openPositions = await this.positionModel
      .find({
        status: { $ne: "CLOSED" },
        totalShares: { $gt: 0 },
      })
      .exec();

    let settledCount = 0;

    for (const pos of openPositions) {
      if (!pos.conditionId || pos.conditionId === "0x") continue;

      let isClosed = false;
      let winningOutcome: string | null = null;
      let resolvedMarketDate: string | undefined = pos.endDate;

      const isHexConditionId = pos.conditionId.startsWith("0x") && pos.conditionId.length >= 64;
      const isTokenIdDecimal = !isHexConditionId && /^\d+$/.test(pos.conditionId);

      // 1. Interrogation CLOB API
      try {
        const clobUrl = isTokenIdDecimal
          ? `https://clob.polymarket.com/markets?token_id=${pos.conditionId}`
          : `https://clob.polymarket.com/markets/${pos.conditionId}`;

        const res = await fetch(clobUrl, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const json = await res.json();
          const data = (Array.isArray(json?.data) ? json.data[0] : json?.data || json) as {
            closed?: boolean;
            end_date_iso?: string;
            game_start_time?: string;
            tokens?: Array<{ outcome?: string; winner?: boolean }>;
          };
          if (!resolvedMarketDate) {
            resolvedMarketDate = data?.end_date_iso || data?.game_start_time;
          }
          if (data?.closed === true && Array.isArray(data?.tokens) && data.tokens.length > 0) {
            const winToken = data.tokens.find((t) => t.winner === true);
            if (winToken?.outcome) {
              isClosed = true;
              winningOutcome = winToken.outcome;
            }
          }
        }
      } catch (_err: unknown) {
        // Fallback vers Gamma
      }

      // 2. Fallback Gamma API si non résolu via CLOB
      if (!winningOutcome) {
        try {
          const effectiveTokenId = isTokenIdDecimal
            ? pos.conditionId
            : pos.assetAddress && /^\d+$/.test(pos.assetAddress)
              ? pos.assetAddress
              : null;

          const gammaUrl = isHexConditionId
            ? `https://gamma-api.polymarket.com/markets?condition_id=${pos.conditionId}`
            : effectiveTokenId
              ? `https://gamma-api.polymarket.com/markets?clob_token_ids=${effectiveTokenId}`
              : pos.marketSlug && pos.marketSlug !== "market" && pos.marketSlug !== "polymarket-market"
                ? `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(pos.marketSlug)}`
                : null;

          if (gammaUrl) {
            const res = await fetch(gammaUrl, { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
              const list = (await res.json()) as Array<{
                closed?: boolean;
                endDate?: string;
                endDateIso?: string;
                tokens?: Array<{ outcome?: string; winner?: boolean }>;
                outcomePrices?: string[] | string;
                outcomes?: string[] | string;
              }>;
              const market = list[0];
              if (market) {
                if (!resolvedMarketDate) {
                  resolvedMarketDate = market.endDate || market.endDateIso;
                }
                if (market.closed === true) {
                  // Vérification tokens
                  const winToken = market.tokens?.find((t) => t.winner === true);
                  if (winToken?.outcome) {
                    isClosed = true;
                    winningOutcome = winToken.outcome;
                  } else {
                    // Analyse outcomePrices (ex: ["1", "0"])
                    const prices =
                      typeof market.outcomePrices === "string"
                        ? JSON.parse(market.outcomePrices)
                        : market.outcomePrices;
                    const outcomes =
                      typeof market.outcomes === "string"
                        ? JSON.parse(market.outcomes)
                        : market.outcomes;

                    if (Array.isArray(prices) && Array.isArray(outcomes)) {
                      const winIdx = prices.findIndex(
                        (p: string | number) => Number(p) >= 0.99
                      );
                      if (winIdx >= 0 && outcomes[winIdx]) {
                        isClosed = true;
                        winningOutcome = String(outcomes[winIdx]);
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (_err: unknown) {
          // Ignorer erreurs temporaires
        }
      }

      if (isClosed && winningOutcome) {
        // Recharger le document frais depuis la base pour éviter toute donnée périmée
        const freshPos = await this.positionModel.findOne({
          _id: pos._id,
          status: { $ne: "CLOSED" },
        });

        if (!freshPos) continue;

        const isWin =
          freshPos.outcomeLabel.trim().toLowerCase() === winningOutcome.trim().toLowerCase();

        const settledPayoutUsdc = isWin ? Number(freshPos.totalShares.toFixed(2)) : 0;
        const realizedPnlUsdc = Number(
          (settledPayoutUsdc - freshPos.totalInvestedUsdc).toFixed(2)
        );
        const closeReason = isWin ? "RESOLVED_WIN" : "RESOLVED_LOSS";
        const now = Date.now();

        // Mise à jour conditionnelle atomique : garantit l'idempotence stricte
        const updatedDoc = await this.positionModel.findOneAndUpdate(
          {
            _id: freshPos._id,
            status: { $ne: "CLOSED" },
          },
          {
            $set: {
              status: "CLOSED",
              closeReason,
              settledPayoutUsdc,
              realizedPnlUsdc,
              currentMarketPrice: isWin ? 1.0 : 0.0,
              currentMarketValueUsdc: settledPayoutUsdc,
              ...(resolvedMarketDate && !freshPos.endDate ? { endDate: resolvedMarketDate } : {}),
              closedAt: now,
              updatedAt: now,
            },
          },
          { new: true }
        );

        if (!updatedDoc) {
          continue;
        }

        settledCount++;

        this.eventsGateway.broadcast("position:closed", {
          conditionId: updatedDoc.conditionId,
          positionId: updatedDoc.positionId,
          closeReason,
          settledPayoutUsdc,
          realizedPnlUsdc,
        });

        // Notification Discord enrichie (une seule fois garantie)
        const mapped = this.mapToPosition(updatedDoc.toObject());
        const alias = await this.getTargetAlias(updatedDoc.targetAddress);
        await this.discordNotifier.sendClosedPositionAlert(mapped, alias);
      } else if (resolvedMarketDate && !pos.endDate) {
        // Même si pas encore résolu, sauvegarder la date résolue trouvée
        await this.positionModel.updateOne(
          { _id: pos._id },
          { $set: { endDate: resolvedMarketDate } }
        );
      }
    }

    return settledCount;
  }

  async findAll(): Promise<OpenPosition[]> {
    // Déclenchement asynchrone en arrière-plan sans bloquer la requête HTTP
    this.settleResolvedPositions(false).catch((_err: unknown) => {
      // Ignorer les erreurs réseau temporaires
    });

    const docs = await this.positionModel
      .find({
        status: { $ne: "CLOSED" },
        totalShares: { $gt: 0 },
      })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    // Résolution paresseuse des dates d'échéance manquantes
    await Promise.all(
      docs.map(async (doc) => {
        if (!doc.endDate && doc.conditionId && doc.conditionId !== "0x") {
          const resolvedDate = await this.resolveMarketEndDate(
            doc.conditionId,
            doc.marketSlug,
            doc.assetAddress
          );
          if (resolvedDate) {
            doc.endDate = resolvedDate;
            await this.positionModel.updateOne(
              { _id: doc._id },
              { $set: { endDate: resolvedDate } }
            );
          }
        }
      })
    );

    return docs.map((doc) => this.mapToPosition(doc));
  }

  async findClosed(): Promise<OpenPosition[]> {
    const docs = await this.positionModel
      .find({ status: "CLOSED" })
      .sort({ closedAt: -1, updatedAt: -1 })
      .limit(100)
      .lean()
      .exec();

    // Résolution paresseuse des dates d'échéance manquantes sur les positions clôturées
    await Promise.all(
      docs.map(async (doc) => {
        if (!doc.endDate && doc.conditionId && doc.conditionId !== "0x") {
          const resolvedDate = await this.resolveMarketEndDate(
            doc.conditionId,
            doc.marketSlug,
            doc.assetAddress
          );
          if (resolvedDate) {
            doc.endDate = resolvedDate;
            await this.positionModel.updateOne(
              { _id: doc._id },
              { $set: { endDate: resolvedDate } }
            );
          }
        }
      })
    );

    return docs.map((doc) => this.mapToPosition(doc));
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
    totals: {
      count: number;
      totalInvested: number;
      totalPayout: number;
      totalGains: number;
      totalLosses: number;
      netPnl: number;
      totalShares: number;
      avgEntryPrice: number;
      winCount: number;
      lossCount: number;
      winRate: number;
      roiPercent: number;
    };
  }> {
    const page = Math.max(1, query.page ? Number(query.page) : 1);
    const limit = Math.min(100, Math.max(1, query.limit ? Number(query.limit) : 25));
    const skip = (page - 1) * limit;

    const matchQuery: Record<string, unknown> = { status: "CLOSED" };
    if (query.status === "WIN") {
      matchQuery.closeReason = "RESOLVED_WIN";
    } else if (query.status === "LOSS") {
      matchQuery.closeReason = "RESOLVED_LOSS";
    }

    const since = query.since ? Number(query.since) : undefined;
    if (since && since > 0) {
      matchQuery.$or = [{ closedAt: { $gte: since } }, { updatedAt: { $gte: since } }];
    }

    const [aggregationResult] = await this.positionModel.aggregate([
      { $match: matchQuery },
      {
        $facet: {
          items: [{ $sort: { closedAt: -1, updatedAt: -1 } }, { $skip: skip }, { $limit: limit }],
          stats: [
            {
              $group: {
                _id: null,
                totalInvested: { $sum: "$totalInvestedUsdc" },
                totalPayout: { $sum: "$settledPayoutUsdc" },
                netPnl: { $sum: "$realizedPnlUsdc" },
                totalShares: { $sum: "$totalShares" },
                winCount: {
                  $sum: {
                    $cond: [{ $eq: ["$closeReason", "RESOLVED_WIN"] }, 1, 0],
                  },
                },
                lossCount: {
                  $sum: {
                    $cond: [{ $eq: ["$closeReason", "RESOLVED_LOSS"] }, 1, 0],
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
              },
            },
          ],
        },
      },
    ]);

    const rawItems = (aggregationResult?.items || []) as PositionDocument[];

    // Résolution paresseuse des dates d'échéance manquantes sur les items paginés
    await Promise.all(
      rawItems.map(async (doc) => {
        if (!doc.endDate && doc.conditionId && doc.conditionId !== "0x") {
          const resolvedDate = await this.resolveMarketEndDate(
            doc.conditionId,
            doc.marketSlug,
            doc.assetAddress
          );
          if (resolvedDate) {
            doc.endDate = resolvedDate;
            await this.positionModel.updateOne(
              { _id: doc._id },
              { $set: { endDate: resolvedDate } }
            );
          }
        }
      })
    );

    const statsDoc = aggregationResult?.stats?.[0] || {
      totalInvested: 0,
      totalPayout: 0,
      netPnl: 0,
      totalShares: 0,
      winCount: 0,
      lossCount: 0,
      totalGains: 0,
      totalLosses: 0,
      count: 0,
    };

    const count = Number(statsDoc.count || 0);
    const totalInvested = Number(statsDoc.totalInvested || 0);
    const totalPayout = Number(statsDoc.totalPayout || 0);
    const netPnl = Number(statsDoc.netPnl || 0);
    const totalShares = Number(statsDoc.totalShares || 0);
    const winCount = Number(statsDoc.winCount || 0);
    const lossCount = Number(statsDoc.lossCount || 0);
    const totalGains = Number(statsDoc.totalGains || 0);
    const totalLosses = Number(statsDoc.totalLosses || 0);
    const avgEntryPrice = totalShares > 0 ? totalInvested / totalShares : 0;
    const winRate = count > 0 ? (winCount / count) * 100 : 0;
    const roiPercent = totalInvested > 0 ? (netPnl / totalInvested) * 100 : 0;

    return {
      items: rawItems.map((doc) => this.mapToPosition(doc)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      totals: {
        count,
        totalInvested,
        totalPayout,
        totalGains,
        totalLosses,
        netPnl,
        totalShares,
        avgEntryPrice,
        winCount,
        lossCount,
        winRate,
        roiPercent,
      },
    };
  }

  async findById(id: string): Promise<OpenPosition> {
    const doc = await this.positionModel.findById(id).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Position introuvable avec l'ID ${id}`);
    }
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
      const resolvedEndDate =
        marketInfo?.endDate ||
        (await this.resolveMarketEndDate(
          trade.conditionId,
          marketInfo?.marketSlug,
          trade.assetAddress
        ));

      const newPos = new this.positionModel({
        positionId,
        conditionId: trade.conditionId,
        assetAddress: (trade.assetAddress || trade.conditionId).toLowerCase(),
        marketSlug: marketInfo?.marketSlug || "market",
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
      if (!existing.endDate) {
        const resolved =
          marketInfo?.endDate ||
          (await this.resolveMarketEndDate(
            trade.conditionId,
            marketInfo?.marketSlug,
            trade.assetAddress
          ));
        if (resolved) {
          existing.endDate = resolved;
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
            realizedPnlUsdc,
            totalShares: 0,
            currentMarketValueUsdc: 0,
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

      // Notification Discord enrichie (une seule fois garantie)
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
      marketQuestion: String(doc.marketQuestion),
      outcomeLabel: String(doc.outcomeLabel),
      endDate: doc.endDate ? String(doc.endDate) : undefined,
      status: statusVal,
      closeReason: closeReasonVal as OpenPosition["closeReason"],
      settledPayoutUsdc:
        doc.settledPayoutUsdc !== undefined ? Number(doc.settledPayoutUsdc) : undefined,
      realizedPnlUsdc: doc.realizedPnlUsdc !== undefined ? Number(doc.realizedPnlUsdc) : undefined,
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
