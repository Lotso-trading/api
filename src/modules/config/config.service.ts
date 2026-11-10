import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { RiskConfig, UpdateRiskConfigInput } from "@polymarket-copy/shared";
import type { Model } from "mongoose";
import { type ConfigDocument, ConfigModel } from "../../database/schemas/config.schema.ts";
import { EventsGateway } from "../gateway/events.gateway.ts";

@Injectable()
export class BotConfigService {
  constructor(
    @InjectModel(ConfigModel.name)
    private readonly configModel: Model<ConfigDocument>,
    private readonly eventsGateway: EventsGateway
  ) {}

  async getConfig(): Promise<RiskConfig & { isBotRunning: boolean }> {
    let doc = await this.configModel.findOne({ key: "singleton" }).lean().exec();
    if (!doc) {
      const created = new this.configModel({
        key: "singleton",
        balancePercentPerTrade: 0.03,
        maxSlippagePercent: 2.0,
        maxCapPerTradeUsdc: 50.0,
        maxExposurePerMarketUsdc: 150.0,
        maxExposurePerTargetUsdc: 300.0,
        minCashReserveUsdc: 5.0,
        minPrice: 0.05,
        maxPrice: 0.9,
        copySellOrders: true,
        dryRun: true,
        maxAllocatedCapitalUsdc: 0,
        profitReinvestmentPercent: 50.0,
        isBotRunning: true,
      });
      const saved = await created.save();
      doc = saved.toObject();
    }

    return {
      balancePercentPerTrade: Number(doc.balancePercentPerTrade),
      maxSlippagePercent: Number(doc.maxSlippagePercent),
      maxCapPerTradeUsdc: Number(doc.maxCapPerTradeUsdc),
      maxExposurePerMarketUsdc: Number(doc.maxExposurePerMarketUsdc ?? 150.0),
      maxExposurePerTargetUsdc: Number(doc.maxExposurePerTargetUsdc ?? 300.0),
      minCashReserveUsdc: Number(doc.minCashReserveUsdc ?? 5.0),
      minPrice: Number(doc.minPrice),
      maxPrice: Number(doc.maxPrice),
      copySellOrders: Boolean(doc.copySellOrders),
      dryRun: Boolean(doc.dryRun),
      maxAllocatedCapitalUsdc: Number(doc.maxAllocatedCapitalUsdc ?? 0),
      profitReinvestmentPercent: Number(doc.profitReinvestmentPercent ?? 50.0),
      isBotRunning: Boolean(doc.isBotRunning),
    };
  }

  async updateConfig(dto: UpdateRiskConfigInput): Promise<RiskConfig & { isBotRunning: boolean }> {
    await this.getConfig(); // Assure la création du singleton
    const updated = await this.configModel
      .findOneAndUpdate(
        { key: "singleton" },
        {
          $set: {
            ...(dto.balancePercentPerTrade !== undefined && {
              balancePercentPerTrade: dto.balancePercentPerTrade,
            }),
            ...(dto.maxSlippagePercent !== undefined && {
              maxSlippagePercent: dto.maxSlippagePercent,
            }),
            ...(dto.maxCapPerTradeUsdc !== undefined && {
              maxCapPerTradeUsdc: dto.maxCapPerTradeUsdc,
            }),
            ...(dto.maxExposurePerMarketUsdc !== undefined && {
              maxExposurePerMarketUsdc: dto.maxExposurePerMarketUsdc,
            }),
            ...(dto.maxExposurePerTargetUsdc !== undefined && {
              maxExposurePerTargetUsdc: dto.maxExposurePerTargetUsdc,
            }),
            ...(dto.minCashReserveUsdc !== undefined && {
              minCashReserveUsdc: dto.minCashReserveUsdc,
            }),
            ...(dto.minPrice !== undefined && { minPrice: dto.minPrice }),
            ...(dto.maxPrice !== undefined && { maxPrice: dto.maxPrice }),
            ...(dto.copySellOrders !== undefined && {
              copySellOrders: dto.copySellOrders,
            }),
            ...(dto.dryRun !== undefined && { dryRun: dto.dryRun }),
            ...(dto.maxAllocatedCapitalUsdc !== undefined && {
              maxAllocatedCapitalUsdc: dto.maxAllocatedCapitalUsdc,
            }),
            ...(dto.profitReinvestmentPercent !== undefined && {
              profitReinvestmentPercent: dto.profitReinvestmentPercent,
            }),
          },
        },
        { new: true }
      )
      .lean()
      .exec();

    const result = {
      balancePercentPerTrade: Number(updated?.balancePercentPerTrade),
      maxSlippagePercent: Number(updated?.maxSlippagePercent),
      maxCapPerTradeUsdc: Number(updated?.maxCapPerTradeUsdc),
      maxExposurePerMarketUsdc: Number(updated?.maxExposurePerMarketUsdc ?? 150.0),
      maxExposurePerTargetUsdc: Number(updated?.maxExposurePerTargetUsdc ?? 300.0),
      minCashReserveUsdc: Number(updated?.minCashReserveUsdc ?? 5.0),
      minPrice: Number(updated?.minPrice),
      maxPrice: Number(updated?.maxPrice),
      copySellOrders: Boolean(updated?.copySellOrders),
      dryRun: Boolean(updated?.dryRun),
      maxAllocatedCapitalUsdc: Number(updated?.maxAllocatedCapitalUsdc ?? 0),
      profitReinvestmentPercent: Number(updated?.profitReinvestmentPercent ?? 50.0),
      isBotRunning: Boolean(updated?.isBotRunning),
    };

    this.eventsGateway.broadcast("config:updated", result);
    return result;
  }
}
