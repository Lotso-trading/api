import { Body, Controller, Get, Post, Put, UsePipes } from "@nestjs/common";
import {
  type RiskConfig,
  type UpdateRiskConfigInput,
  UpdateRiskConfigInputSchema,
  type WalletAdjustmentInput,
  WalletAdjustmentInputSchema,
  type WalletDepositInput,
  WalletDepositInputSchema,
  type WalletWithdrawInput,
  WalletWithdrawInputSchema,
} from "@polymarket-copy/shared";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe.ts";
import { BotConfigService } from "./config.service.ts";

@Controller("config")
export class ConfigController {
  constructor(private readonly configService: BotConfigService) {}

  @Get()
  async getConfig(): Promise<RiskConfig> {
    return await this.configService.getConfig();
  }

  @Put()
  @UsePipes(new ZodValidationPipe(UpdateRiskConfigInputSchema))
  async updateConfig(@Body() dto: UpdateRiskConfigInput): Promise<RiskConfig> {
    return await this.configService.updateConfig(dto);
  }

  @Post("wallet/deposit")
  @UsePipes(new ZodValidationPipe(WalletDepositInputSchema))
  async deposit(
    @Body() dto: WalletDepositInput
  ): Promise<{ success: boolean; simulatedBalanceUsdc: number; availableCashUsdc: number }> {
    return await this.configService.adjustVirtualWallet("DEPOSIT", dto.amountUsdc);
  }

  @Post("wallet/withdraw")
  @UsePipes(new ZodValidationPipe(WalletWithdrawInputSchema))
  async withdraw(
    @Body() dto: WalletWithdrawInput
  ): Promise<{ success: boolean; simulatedBalanceUsdc: number; availableCashUsdc: number }> {
    return await this.configService.adjustVirtualWallet("WITHDRAW", dto.amountUsdc);
  }

  @Post("wallet/adjust")
  @UsePipes(new ZodValidationPipe(WalletAdjustmentInputSchema))
  async adjust(
    @Body() dto: WalletAdjustmentInput
  ): Promise<{ success: boolean; simulatedBalanceUsdc: number; availableCashUsdc: number }> {
    return await this.configService.adjustVirtualWallet(dto.action, dto.amountUsdc);
  }

  @Post("heartbeat")
  async heartbeat(): Promise<{ success: boolean }> {
    await this.configService.recordHeartbeat();
    return { success: true };
  }

  @Post("shutdown")
  async shutdown(): Promise<{ success: boolean }> {
    await this.configService.recordShutdown();
    return { success: true };
  }
}
