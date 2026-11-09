import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { TradeSide, TradeStatus } from "@polymarket-copy/shared";
import type { HydratedDocument } from "mongoose";

export type TradeDocument = HydratedDocument<TradeModel>;

@Schema({ timestamps: true, collection: "trades" })
export class TradeModel {
  @Prop({ required: true, unique: true, index: true })
  tradeId!: string;

  @Prop({ required: true, index: true })
  detectedTradeId!: string;

  @Prop({ required: true, lowercase: true, trim: true, index: true })
  targetAddress!: string;

  @Prop({ required: true, index: true })
  conditionId!: string;

  @Prop({ required: false })
  marketSlug?: string;

  @Prop({ required: false })
  marketQuestion?: string;

  @Prop({ required: false })
  outcomeLabel?: string;

  @Prop({ required: false })
  endDate?: string;

  @Prop({ required: true, type: String, enum: ["BUY", "SELL"] })
  side!: TradeSide;

  @Prop({ required: true })
  targetPrice!: number;

  @Prop({ required: true })
  executedPrice!: number;

  @Prop({ required: true })
  slippagePercent!: number;

  @Prop({ required: true })
  shares!: number;

  @Prop({ required: true })
  costUsdc!: number;

  @Prop({ required: false })
  orderId?: string;

  @Prop({ required: false, sparse: true, index: true })
  transactionHash?: string;

  @Prop({
    required: true,
    type: String,
    enum: ["DETECTED", "VALIDATED", "REJECTED", "EXECUTING", "FILLED", "FAILED"],
    index: true,
  })
  status!: TradeStatus;

  @Prop({ required: false })
  rejectionReason?: string;

  @Prop({ required: true, default: false })
  isDryRun!: boolean;

  @Prop({ required: true, index: true })
  executedAt!: number;
}

export const TradeSchema = SchemaFactory.createForClass(TradeModel);

// Index composés obligatoires
TradeSchema.index({ targetAddress: 1, executedAt: -1 });
TradeSchema.index({ conditionId: 1, side: 1, status: 1 });
