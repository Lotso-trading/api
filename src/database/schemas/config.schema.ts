import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { RiskConfig } from "@polymarket-copy/shared";
import type { HydratedDocument } from "mongoose";

export type ConfigDocument = HydratedDocument<ConfigModel>;

@Schema({ timestamps: true, collection: "configs" })
export class ConfigModel implements Omit<RiskConfig, "isBotOnline"> {
  @Prop({ required: true, default: "singleton", unique: true })
  key!: string;

  @Prop({ required: true, default: 0.03 })
  balancePercentPerTrade!: number;

  @Prop({ required: true, default: 2.0 })
  maxSlippagePercent!: number;

  @Prop({ required: true, default: 50.0 })
  maxCapPerTradeUsdc!: number;

  @Prop({ required: true, default: 150.0 })
  maxExposurePerMarketUsdc!: number;

  @Prop({ required: true, default: 300.0 })
  maxExposurePerTargetUsdc!: number;

  @Prop({ required: true, default: 5.0 })
  minCashReserveUsdc!: number;

  @Prop({ required: true, default: 0.05 })
  minPrice!: number;

  @Prop({ required: true, default: 0.9 })
  maxPrice!: number;

  @Prop({ required: true, default: true })
  copySellOrders!: boolean;

  @Prop({ required: true, default: true })
  dryRun!: boolean;

  @Prop({ required: true, default: 0 })
  maxAllocatedCapitalUsdc!: number;

  @Prop({ required: true, default: 50.0 })
  profitReinvestmentPercent!: number;

  @Prop({ required: true, default: true })
  isBotRunning!: boolean;

  @Prop({ required: false })
  discordWebhookUrl?: string;
}

export const ConfigSchema = SchemaFactory.createForClass(ConfigModel);
