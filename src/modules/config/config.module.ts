import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ConfigModel, ConfigSchema } from "../../database/schemas/config.schema.ts";
import { ConfigController } from "./config.controller.ts";
import { BotConfigService } from "./config.service.ts";

@Module({
  imports: [MongooseModule.forFeature([{ name: ConfigModel.name, schema: ConfigSchema }])],
  controllers: [ConfigController],
  providers: [BotConfigService],
  exports: [BotConfigService],
})
export class ConfigModule {}
