import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { TargetTraderStats } from "@polymarket-copy/shared";
import type { HydratedDocument } from "mongoose";

export type TargetDocument = HydratedDocument<TargetModel>;

@Schema({ _id: false })
export class TargetStatsModel implements TargetTraderStats {
  @Prop({ required: true, default: 0 })
  totalCopiedTrades!: number;

  @Prop({ required: true, default: 0 })
  totalCopiedVolumeUsdc!: number;

  @Prop({ required: true, default: 0 })
  realizedPnlUsdc!: number;

  @Prop({ required: true, default: 0 })
  winRatePercent!: number;
}

const TargetStatsSchema = SchemaFactory.createForClass(TargetStatsModel);

@Schema({ timestamps: true, collection: "targets" })
export class TargetModel {
  @Prop({ required: true, unique: true, index: true, lowercase: true, trim: true })
  address!: string;

  @Prop({ required: false, lowercase: true, trim: true })
  proxyAddress?: string;

  @Prop({ required: false, trim: true })
  username?: string;

  @Prop({ required: true, trim: true })
  alias!: string;

  @Prop({ required: true, default: true, index: true })
  enabled!: boolean;

  @Prop({ required: false })
  maxUsdcPerTrade?: number;

  @Prop({ required: true, default: 1.0 })
  weightMultiplier!: number;

  @Prop({ type: TargetStatsSchema, default: () => ({}) })
  stats!: TargetStatsModel;
}

export const TargetSchema = SchemaFactory.createForClass(TargetModel);
