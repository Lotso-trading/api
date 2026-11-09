import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PositionModel, PositionSchema } from "../../database/schemas/position.schema.ts";
import { TargetModel, TargetSchema } from "../../database/schemas/target.schema.ts";
import { TradeModel, TradeSchema } from "../../database/schemas/trade.schema.ts";
import { MetricsController } from "./metrics.controller.ts";
import { MetricsService } from "./metrics.service.ts";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TradeModel.name, schema: TradeSchema },
      { name: PositionModel.name, schema: PositionSchema },
      { name: TargetModel.name, schema: TargetSchema },
    ]),
  ],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
