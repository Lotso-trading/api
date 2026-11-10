import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { type PositionDocument, PositionModel } from "../../database/schemas/position.schema.ts";
import { type TargetDocument, TargetModel } from "../../database/schemas/target.schema.ts";
import { type TradeDocument, TradeModel } from "../../database/schemas/trade.schema.ts";

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

@Injectable()
export class MetricsService {
  constructor(
    @InjectModel(TradeModel.name)
    private readonly tradeModel: Model<TradeDocument>,
    @InjectModel(PositionModel.name)
    private readonly positionModel: Model<PositionDocument>,
    @InjectModel(TargetModel.name)
    private readonly targetModel: Model<TargetDocument>
  ) {}

  async getMetrics(): Promise<GlobalMetrics> {
    const [tradeAgg, positionAgg, closedAgg, activeTargetsCount, rejectedCount] = await Promise.all(
      [
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
      ]
    );

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

    const initialCapitalUsdc = Number(Deno.env.get("SIMULATED_BALANCE_USDC")) || 100.0;
    const totalInvestedUsdc = Number(positionStats.totalInvested || 0);
    const realizedPnlUsdc = Number(closedStats.totalRealizedPnl || 0);
    const availableCashUsdc = Math.max(0, initialCapitalUsdc - totalInvestedUsdc + realizedPnlUsdc);
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
    const targets = await this.targetModel.find({}).lean().exec();
    const targetMap = new Map<string, string>();
    for (const t of targets) {
      targetMap.set(t.address.toLowerCase(), t.alias);
    }

    const trades = await this.tradeModel
      .find({ status: "FILLED" })
      .sort({ executedAt: 1 })
      .lean()
      .exec();

    const initialCapital = Number(Deno.env.get("SIMULATED_BALANCE_USDC")) || 100.0;
    let runningCash = initialCapital;
    let runningCumulativePnl = 0.0;
    let runningWhaleVolume = 0.0;

    const points: PerformancePoint[] = [];

    // Point initial de départ
    const firstTrade = trades[0];
    const startTimestamp =
      firstTrade !== undefined ? firstTrade.executedAt - 60000 : Date.now() - 3600000;
    points.push({
      timestamp: startTimestamp,
      myCumulativePnlUsdc: 0,
      portfolioValueUsdc: initialCapital,
      whaleCumulativeUsdc: 0,
    });

    for (const trade of trades) {
      const alias =
        targetMap.get(trade.targetAddress.toLowerCase()) || trade.targetAddress.slice(0, 8);
      runningWhaleVolume += trade.costUsdc;

      if (trade.side === "BUY") {
        runningCash = Math.max(0, runningCash - trade.costUsdc);
      } else if (trade.side === "SELL") {
        runningCash += trade.costUsdc;
        runningCumulativePnl += (trade.executedPrice - trade.targetPrice) * trade.shares;
      }

      points.push({
        timestamp: trade.executedAt,
        tradeId: trade.tradeId,
        side: trade.side,
        shares: trade.shares,
        price: trade.executedPrice,
        costUsdc: trade.costUsdc,
        targetAddress: trade.targetAddress,
        targetAlias: alias,
        myCumulativePnlUsdc: Math.round(runningCumulativePnl * 100) / 100,
        portfolioValueUsdc:
          Math.round((runningCash + (trade.side === "BUY" ? trade.costUsdc : 0)) * 100) / 100,
        whaleCumulativeUsdc: Math.round(runningWhaleVolume * 100) / 100,
      });
    }

    return points;
  }
}
