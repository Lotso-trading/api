import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";

export type PositionDocument = HydratedDocument<PositionModel>;

@Schema({ timestamps: true, collection: "positions" })
export class PositionModel {
  @Prop({ required: true, unique: true, index: true })
  positionId!: string;

  @Prop({ required: true, index: true })
  conditionId!: string;

  @Prop({ required: true, lowercase: true, trim: true, index: true })
  assetAddress!: string;

  @Prop({ required: true })
  marketSlug!: string;

  @Prop({ required: true })
  marketQuestion!: string;

  @Prop({ required: true })
  outcomeLabel!: string;

  @Prop({ required: false })
  endDate?: string;

  @Prop({ required: true, default: "OPEN", enum: ["OPEN", "CLOSED"], index: true })
  status!: "OPEN" | "CLOSED";

  @Prop({ required: false, enum: ["RESOLVED_WIN", "RESOLVED_LOSS", "WHALE_SELL", "MANUAL"] })
  closeReason?: "RESOLVED_WIN" | "RESOLVED_LOSS" | "WHALE_SELL" | "MANUAL";

  @Prop({ required: false })
  settledPayoutUsdc?: number;

  @Prop({ required: false })
  realizedPnlUsdc?: number;

  @Prop({ required: false, index: true })
  closedAt?: number;

  @Prop({ required: true })
  totalShares!: number;

  @Prop({ required: true })
  avgEntryPrice!: number;

  @Prop({ required: true })
  totalInvestedUsdc!: number;

  @Prop({ required: true })
  currentMarketPrice!: number;

  @Prop({ required: true, default: 0 })
  currentMarketValueUsdc!: number;

  @Prop({ required: true, default: 0 })
  unrealizedPnlUsdc!: number;

  @Prop({ required: true, default: 0 })
  unrealizedPnlPercent!: number;

  @Prop({ required: true, lowercase: true, trim: true, index: true })
  targetAddress!: string;

  @Prop({ required: true })
  openedAt!: number;

  @Prop({ required: true, index: true })
  updatedAt!: number;
}

export const PositionSchema = SchemaFactory.createForClass(PositionModel);

// Index composé unique pour lookup en O(1) lors des ordres de vente SELL
PositionSchema.index({ conditionId: 1, assetAddress: 1 }, { unique: true });
PositionSchema.index({ targetAddress: 1, updatedAt: -1 });
