import { Body, Controller, Get, Put, UsePipes } from "@nestjs/common";
import {
  type RiskConfig,
  type UpdateRiskConfigInput,
  UpdateRiskConfigInputSchema,
} from "@polymarket-copy/shared";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe.ts";
import { BotConfigService } from "./config.service.ts";

@Controller("config")
export class ConfigController {
  constructor(private readonly configService: BotConfigService) {}

  @Get()
  async getConfig(): Promise<RiskConfig & { isBotRunning: boolean }> {
    return await this.configService.getConfig();
  }

  @Put()
  @UsePipes(new ZodValidationPipe(UpdateRiskConfigInputSchema))
  async updateConfig(
    @Body() dto: UpdateRiskConfigInput
  ): Promise<RiskConfig & { isBotRunning: boolean }> {
    return await this.configService.updateConfig(dto);
  }
}
