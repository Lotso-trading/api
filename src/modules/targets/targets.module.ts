import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { TargetModel, TargetSchema } from "../../database/schemas/target.schema.ts";
import { TargetsController } from "./targets.controller.ts";
import { TargetsService } from "./targets.service.ts";

@Module({
  imports: [MongooseModule.forFeature([{ name: TargetModel.name, schema: TargetSchema }])],
  controllers: [TargetsController],
  providers: [TargetsService],
  exports: [TargetsService],
})
export class TargetsModule {}
