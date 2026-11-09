import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { AddTargetInput, TargetTrader, UpdateTargetInput } from "@polymarket-copy/shared";
import type { Model } from "mongoose";
import { type TargetDocument, TargetModel } from "../../database/schemas/target.schema.ts";
import { EventsGateway } from "../gateway/events.gateway.ts";

@Injectable()
export class TargetsService {
  constructor(
    @InjectModel(TargetModel.name)
    private readonly targetModel: Model<TargetDocument>,
    private readonly eventsGateway: EventsGateway
  ) {}

  async findAll(): Promise<TargetTrader[]> {
    const docs = await this.targetModel.find().lean().exec();
    return docs.map((doc) => this.mapToTrader(doc));
  }

  async findById(id: string): Promise<TargetTrader> {
    const doc = await this.targetModel.findById(id).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Baleine cible introuvable avec l'ID ${id}`);
    }
    return this.mapToTrader(doc);
  }

  async findByAddress(address: string): Promise<TargetTrader | null> {
    const doc = await this.targetModel.findOne({ address: address.toLowerCase() }).lean().exec();
    return doc ? this.mapToTrader(doc) : null;
  }

  async create(dto: AddTargetInput): Promise<TargetTrader> {
    const existing = await this.findByAddress(dto.address);
    if (existing) {
      throw new BadRequestException(`Une cible avec l'adresse ${dto.address} existe déjà`);
    }

    const created = new this.targetModel({
      address: dto.address.toLowerCase(),
      proxyAddress: dto.proxyAddress?.toLowerCase(),
      username: dto.username,
      alias: dto.alias,
      enabled: dto.enabled,
      maxUsdcPerTrade: dto.maxUsdcPerTrade,
      weightMultiplier: dto.weightMultiplier,
      stats: {
        totalCopiedTrades: 0,
        totalCopiedVolumeUsdc: 0,
        realizedPnlUsdc: 0,
        winRatePercent: 0,
      },
    });

    const saved = await created.save();
    const result = this.mapToTrader(saved.toObject());
    this.eventsGateway.broadcast("target:created", result);
    return result;
  }

  async update(id: string, dto: UpdateTargetInput): Promise<TargetTrader> {
    const updated = await this.targetModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            ...(dto.alias !== undefined && { alias: dto.alias }),
            ...(dto.proxyAddress !== undefined && {
              proxyAddress: dto.proxyAddress.toLowerCase(),
            }),
            ...(dto.username !== undefined && { username: dto.username }),
            ...(dto.enabled !== undefined && { enabled: dto.enabled }),
            ...(dto.maxUsdcPerTrade !== undefined && {
              maxUsdcPerTrade: dto.maxUsdcPerTrade,
            }),
            ...(dto.weightMultiplier !== undefined && {
              weightMultiplier: dto.weightMultiplier,
            }),
          },
        },
        { new: true }
      )
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException(`Baleine cible introuvable avec l'ID ${id}`);
    }

    const result = this.mapToTrader(updated);
    this.eventsGateway.broadcast("target:updated", result);
    return result;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.targetModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Baleine cible introuvable avec l'ID ${id}`);
    }
    this.eventsGateway.broadcast("target:deleted", { id });
    return true;
  }

  private mapToTrader(rawDoc: unknown): TargetTrader {
    const doc = rawDoc as Record<string, unknown>;
    return {
      id: String(doc._id ?? doc.id),
      address: String(doc.address),
      proxyAddress: doc.proxyAddress ? String(doc.proxyAddress) : undefined,
      username: doc.username ? String(doc.username) : undefined,
      alias: String(doc.alias),
      enabled: Boolean(doc.enabled),
      maxUsdcPerTrade: doc.maxUsdcPerTrade !== undefined ? Number(doc.maxUsdcPerTrade) : undefined,
      weightMultiplier: Number(doc.weightMultiplier ?? 1.0),
      stats: (doc.stats as TargetTrader["stats"]) || {
        totalCopiedTrades: 0,
        totalCopiedVolumeUsdc: 0,
        realizedPnlUsdc: 0,
        winRatePercent: 0,
      },
      createdAt: doc.createdAt instanceof Date ? doc.createdAt.getTime() : Date.now(),
      updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.getTime() : Date.now(),
    };
  }
}
