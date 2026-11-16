import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PositionModel, PositionSchema } from "../../database/schemas/position.schema.ts";
import { TargetModel, TargetSchema } from "../../database/schemas/target.schema.ts";
import { TargetsController } from "./targets.controller.ts";
import { TargetsService } from "./targets.service.ts";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TargetModel.name, schema: TargetSchema },
      { name: PositionModel.name, schema: PositionSchema },
    ]),
  ],
  controllers: [TargetsController],
  providers: [TargetsService],
  exports: [TargetsService],
})
export class TargetsModule {}
