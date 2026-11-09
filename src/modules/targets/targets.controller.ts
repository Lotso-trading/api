import { Body, Controller, Delete, Get, Param, Patch, Post, UsePipes } from "@nestjs/common";
import {
  type AddTargetInput,
  AddTargetInputSchema,
  type TargetTrader,
  type UpdateTargetInput,
  UpdateTargetInputSchema,
} from "@polymarket-copy/shared";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe.ts";
import { TargetsService } from "./targets.service.ts";

@Controller("targets")
export class TargetsController {
  constructor(private readonly targetsService: TargetsService) {}

  @Get()
  async findAll(): Promise<TargetTrader[]> {
    return await this.targetsService.findAll();
  }

  @Get(":id")
  async findById(@Param("id") id: string): Promise<TargetTrader> {
    return await this.targetsService.findById(id);
  }

  @Post()
  @UsePipes(new ZodValidationPipe(AddTargetInputSchema))
  async create(@Body() dto: AddTargetInput): Promise<TargetTrader> {
    return await this.targetsService.create(dto);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateTargetInputSchema)) dto: UpdateTargetInput
  ): Promise<TargetTrader> {
    return await this.targetsService.update(id, dto);
  }

  @Delete(":id")
  async delete(@Param("id") id: string): Promise<{ deleted: boolean }> {
    const deleted = await this.targetsService.delete(id);
    return { deleted };
  }
}
