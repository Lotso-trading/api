import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { RiskConfig, UpdateRiskConfigInput } from "@polymarket-copy/shared";
import type { Model } from "mongoose";
import { type ConfigDocument, ConfigModel } from "../../database/schemas/config.schema.ts";
import { EventsGateway } from "../gateway/events.gateway.ts";
import { MetricsService } from "../metrics/metrics.service.ts";

@Injectable()
export class BotConfigService {
  private isBotOnlineState = false;

  constructor(
    @InjectModel(ConfigModel.name)
    private readonly configModel: Model<ConfigDocument>,
    private readonly eventsGateway: EventsGateway,
    private readonly metricsService: MetricsService
  ) {
    this.eventsGateway.onBotPresenceChange(async (isOnline: boolean) => {
      this.isBotOnlineState = isOnline;
      const cfg = await this.getConfig();
      this.eventsGateway.broadcast("config:updated", cfg);
    });
  }

  isBotOnline(): boolean {
    return this.isBotOnlineState || this.eventsGateway.isBotConnected();
  }

  setBotOnline(isOnline: boolean): void {
    this.isBotOnlineState = isOnline;
  }

  async recordHeartbeat(): Promise<void> {
    this.setBotOnline(true);
    const cfg = await this.getConfig();
    this.eventsGateway.broadcast("config:updated", cfg);
  }

  async recordShutdown(): Promise<void> {
    this.setBotOnline(false);
    const cfg = await this.getConfig();
    this.eventsGateway.broadcast("config:updated", cfg);
  }

  async getConfig(): Promise<RiskConfig> {
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
        simulatedBalanceUsdc: 1000.0,
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
      simulatedBalanceUsdc: Number(doc.simulatedBalanceUsdc ?? 1000.0),
      maxAllocatedCapitalUsdc: Number(doc.maxAllocatedCapitalUsdc ?? 0),
      profitReinvestmentPercent: Number(doc.profitReinvestmentPercent ?? 50.0),
      isBotRunning: Boolean(doc.isBotRunning),
      isBotOnline: this.isBotOnline(),
    };
  }

  async updateConfig(dto: UpdateRiskConfigInput): Promise<RiskConfig> {
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
            ...(dto.simulatedBalanceUsdc !== undefined && {
              simulatedBalanceUsdc: dto.simulatedBalanceUsdc,
            }),
            ...(dto.maxAllocatedCapitalUsdc !== undefined && {
              maxAllocatedCapitalUsdc: dto.maxAllocatedCapitalUsdc,
            }),
            ...(dto.profitReinvestmentPercent !== undefined && {
              profitReinvestmentPercent: dto.profitReinvestmentPercent,
            }),
            ...(dto.isBotRunning !== undefined && {
              isBotRunning: dto.isBotRunning,
            }),
          },
        },
        { new: true }
      )
      .lean()
      .exec();

    const result: RiskConfig = {
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
      simulatedBalanceUsdc: Number(updated?.simulatedBalanceUsdc ?? 1000.0),
      maxAllocatedCapitalUsdc: Number(updated?.maxAllocatedCapitalUsdc ?? 0),
      profitReinvestmentPercent: Number(updated?.profitReinvestmentPercent ?? 50.0),
      isBotRunning: Boolean(updated?.isBotRunning),
      isBotOnline: this.isBotOnline(),
    };

    this.eventsGateway.broadcast("config:updated", result);
    return result;
  }

  async adjustVirtualWallet(
    action: "DEPOSIT" | "WITHDRAW",
    amountUsdc: number
  ): Promise<{ success: boolean; simulatedBalanceUsdc: number; availableCashUsdc: number }> {
    if (amountUsdc <= 0) {
      throw new BadRequestException("Le montant doit être strictement supérieur à zéro.");
    }

    const currentConfig = await this.getConfig();
    const metrics = await this.metricsService.getMetrics();

    if (action === "WITHDRAW") {
      const maxAllowedWithdrawal = metrics.availableCashUsdc;
      if (amountUsdc > maxAllowedWithdrawal) {
        throw new BadRequestException(
          `Retrait refusé : solde libre insuffisant (${amountUsdc.toFixed(2)} $ demandé > ${maxAllowedWithdrawal.toFixed(2)} $ disponible). Des fonds sont actuellement engagés dans des marchés.`
        );
      }
    }

    const currentSimulated = currentConfig.simulatedBalanceUsdc ?? 1000.0;
    const newSimulatedBalance =
      action === "DEPOSIT"
        ? Math.round((currentSimulated + amountUsdc) * 100) / 100
        : Math.round(Math.max(0, currentSimulated - amountUsdc) * 100) / 100;

    await this.updateConfig({ simulatedBalanceUsdc: newSimulatedBalance });
    const updatedMetrics = await this.metricsService.broadcastMetrics();

    return {
      success: true,
      simulatedBalanceUsdc: newSimulatedBalance,
      availableCashUsdc: updatedMetrics.availableCashUsdc,
    };
  }
}
