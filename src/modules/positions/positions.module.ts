import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PositionModel, PositionSchema } from "../../database/schemas/position.schema.ts";
import { TargetModel, TargetSchema } from "../../database/schemas/target.schema.ts";
import { PositionsController } from "./positions.controller.ts";
import { PositionsService } from "./positions.service.ts";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PositionModel.name, schema: PositionSchema },
      { name: TargetModel.name, schema: TargetSchema },
    ]),
  ],
  controllers: [PositionsController],
  providers: [PositionsService],
  exports: [PositionsService],
})
export class PositionsModule {}
