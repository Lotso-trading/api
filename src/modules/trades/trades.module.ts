import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { TargetModel, TargetSchema } from "../../database/schemas/target.schema.ts";
import { TradeModel, TradeSchema } from "../../database/schemas/trade.schema.ts";
import { PositionsModule } from "../positions/positions.module.ts";
import { TradesController } from "./trades.controller.ts";
import { TradesService } from "./trades.service.ts";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TradeModel.name, schema: TradeSchema },
      { name: TargetModel.name, schema: TargetSchema },
    ]),
    PositionsModule,
  ],
  controllers: [TradesController],
  providers: [TradesService],
  exports: [TradesService],
})
export class TradesModule {}
