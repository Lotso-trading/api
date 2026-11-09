import { Controller, Get, Param, Post } from "@nestjs/common";
import type { OpenPosition } from "@polymarket-copy/shared";
import { PositionsService } from "./positions.service.ts";

@Controller("positions")
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Get()
  async findAll(): Promise<OpenPosition[]> {
    return await this.positionsService.findAll();
  }

  @Get("closed")
  async findClosed(): Promise<OpenPosition[]> {
    return await this.positionsService.findClosed();
  }

  @Post("settle")
  async settle(): Promise<{ settledCount: number; message: string }> {
    const settledCount = await this.positionsService.settleResolvedPositions(true);
    return {
      settledCount,
      message: `${settledCount} position(s) résolue(s) et créditée(s) au cash disponible.`,
    };
  }

  @Get(":id")
  async findById(@Param("id") id: string): Promise<OpenPosition> {
    return await this.positionsService.findById(id);
  }
}
