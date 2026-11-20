import { Injectable } from "@nestjs/common";
import type { Model } from "mongoose";
import type { PositionDocument } from "../../database/schemas/position.schema.ts";

const CORRUPTED_EVENT_SLUG = "xi-jinping-out-before-2027";
const IGNORED_MARKET_SLUGS = new Set(["market", "polymarket-market", "polygon-onchain"]);

interface CachedMarketMetadata {
    date: string;
    eventSlug?: string;
    timestamp: number;
}

export interface PositionMetadataFields {
    _id?: unknown;
    conditionId?: string;
    marketSlug?: string;
    assetAddress?: string;
    endDate?: string;
    eventSlug?: string;
}

@Injectable()
export class PolymarketMetadataService {
    private readonly cache = new Map<string, CachedMarketMetadata>();

    isCorruptedEventSlug(eventSlug?: string, marketSlug?: string): boolean {
        return eventSlug === CORRUPTED_EVENT_SLUG && marketSlug !== CORRUPTED_EVENT_SLUG;
    }

    async sanitizeCorruptedEventSlugs(positionModel: Model<PositionDocument>): Promise<number> {
        try {
            const cleanupResult = await positionModel.updateMany(
                {
                    eventSlug: CORRUPTED_EVENT_SLUG,
                    marketSlug: { $ne: CORRUPTED_EVENT_SLUG },
                },
                { $unset: { eventSlug: "" } }
            );
            if (cleanupResult.modifiedCount > 0) {
                console.log(
                    `[PolymarketMetadata] ${cleanupResult.modifiedCount} position(s) avec eventSlug corrompu nettoyée(s).`
                );
            }
            return cleanupResult.modifiedCount;
        } catch (err: unknown) {
            console.warn("[PolymarketMetadata] Erreur nettoyage eventSlug corrompu:", err);
            return 0;
        }
    }

    async backfillMissingMetadata(positionModel: Model<PositionDocument>): Promise<void> {
        try {
            const positionsToBackfill = await positionModel
                .find({
                    $or: [
                        { endDate: { $exists: false } },
                        { endDate: "" },
                        { endDate: null },
                        { eventSlug: { $exists: false } },
                        { eventSlug: "" },
                        { eventSlug: null },
                        {
                            eventSlug: CORRUPTED_EVENT_SLUG,
                            marketSlug: { $ne: CORRUPTED_EVENT_SLUG },
                        },
                    ],
                    conditionId: { $ne: "0x" },
                })
                .limit(200)
                .exec();

            if (positionsToBackfill.length === 0) return;

            console.log(
                `[PolymarketMetadata] Rétro-résolution des métadonnées pour ${positionsToBackfill.length} position(s)...`
            );

            let resolvedCount = 0;
            for (const pos of positionsToBackfill) {
                const updated = await this.enrichSinglePosition(pos, positionModel);
                if (updated) resolvedCount++;
            }

            console.log(
                `[PolymarketMetadata] Rétro-résolution terminée : ${resolvedCount}/${positionsToBackfill.length} position(s) mise(s) à jour.`
            );
        } catch (err: unknown) {
            console.warn("[PolymarketMetadata] Erreur lors de la rétro-résolution:", err);
        }
    }

    async enrichPositionsMetadata<T extends PositionMetadataFields>(
        docs: T[],
        positionModel: Model<PositionDocument>
    ): Promise<void> {
        await Promise.all(docs.map((doc) => this.enrichSinglePosition(doc, positionModel)));
    }

    private async enrichSinglePosition<T extends PositionMetadataFields>(
        doc: T,
        positionModel: Model<PositionDocument>
    ): Promise<boolean> {
        const isCorrupted = this.isCorruptedEventSlug(doc.eventSlug, doc.marketSlug);
        if (
            (!doc.endDate || !doc.eventSlug || isCorrupted) &&
            doc.conditionId &&
            doc.conditionId !== "0x"
        ) {
            const resolved = await this.resolveMarketMetadata(
                doc.conditionId,
                doc.marketSlug,
                doc.assetAddress
            );
            const updateFields: Record<string, string> = {};
            if (resolved.endDate && !doc.endDate) {
                doc.endDate = resolved.endDate;
                updateFields.endDate = resolved.endDate;
            }
            if (resolved.eventSlug && (!doc.eventSlug || isCorrupted)) {
                doc.eventSlug = resolved.eventSlug;
                updateFields.eventSlug = resolved.eventSlug;
            }
            if (Object.keys(updateFields).length > 0 && doc._id !== undefined) {
                await positionModel.updateOne({ _id: doc._id }, { $set: updateFields });
                return true;
            }
        }
        return false;
    }

    async resolveMarketMetadata(
        conditionId: string,
        marketSlug?: string,
        assetAddress?: string
    ): Promise<{ endDate?: string; eventSlug?: string }> {
        if (!conditionId || conditionId === "0x") return {};

        const cached = this.cache.get(conditionId);
        if (cached) {
            if (cached.date || cached.eventSlug) {
                return { endDate: cached.date || undefined, eventSlug: cached.eventSlug };
            }
            if (Date.now() - cached.timestamp < 300_000) {
                return {};
            }
        }

        let resolvedDate: string | undefined;
        let resolvedEventSlug: string | undefined;

        const isHexConditionId = conditionId.startsWith("0x") && conditionId.length >= 64;
        const isTokenIdDecimal = !isHexConditionId && /^\d+$/.test(conditionId);

        // 1. Appel CLOB API
        try {
            const clobUrl = isTokenIdDecimal
                ? `https://clob.polymarket.com/markets?token_id=${conditionId}`
                : `https://clob.polymarket.com/markets/${conditionId}`;

            const res = await fetch(clobUrl, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const json = await res.json();
                const data = (Array.isArray(json?.data) ? json.data[0] : json?.data || json) as {
                    end_date_iso?: string;
                    game_start_time?: string;
                    endDate?: string;
                };
                resolvedDate = data?.end_date_iso || data?.game_start_time || data?.endDate;
            }
        } catch (_err: unknown) {
            // Poursuite vers Gamma
        }

        // 2. Appel Gamma API par condition_ids
        if (isHexConditionId) {
            try {
                const res = await fetch(
                    `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (res.ok) {
                    const list = (await res.json()) as Array<{
                        conditionId?: string;
                        endDate?: string;
                        endDateIso?: string;
                        game_start_time?: string;
                        events?: Array<{ slug?: string }>;
                    }>;
                    const matched = Array.isArray(list)
                        ? list.find(
                              (m) => m?.conditionId?.toLowerCase() === conditionId.toLowerCase()
                          )
                        : undefined;
                    if (matched) {
                        resolvedDate ??=
                            matched.endDate || matched.endDateIso || matched.game_start_time;
                        resolvedEventSlug ??= matched.events?.[0]?.slug;
                    }
                }
            } catch (_err: unknown) {
                // Poursuite vers Token ID / Slug
            }
        }

        // 3. Appel Gamma API par Token ID
        const effectiveTokenId = isTokenIdDecimal
            ? conditionId
            : assetAddress && /^\d+$/.test(assetAddress)
              ? assetAddress
              : null;

        if (effectiveTokenId && (!resolvedDate || !resolvedEventSlug)) {
            try {
                const res = await fetch(
                    `https://gamma-api.polymarket.com/markets?clob_token_ids=${effectiveTokenId}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (res.ok) {
                    const list = (await res.json()) as Array<{
                        conditionId?: string;
                        clobTokenIds?: string[] | string;
                        endDate?: string;
                        endDateIso?: string;
                        game_start_time?: string;
                        events?: Array<{ slug?: string }>;
                    }>;
                    const matched = Array.isArray(list)
                        ? list.find((m) => {
                              if (!m) return false;
                              if (
                                  m.conditionId &&
                                  m.conditionId.toLowerCase() === conditionId.toLowerCase()
                              ) {
                                  return true;
                              }
                              if (m.clobTokenIds) {
                                  const ids =
                                      typeof m.clobTokenIds === "string"
                                          ? JSON.parse(m.clobTokenIds)
                                          : m.clobTokenIds;
                                  return Array.isArray(ids) && ids.includes(effectiveTokenId);
                              }
                              return true;
                          })
                        : undefined;
                    if (matched) {
                        resolvedDate ??=
                            matched.endDate || matched.endDateIso || matched.game_start_time;
                        resolvedEventSlug ??= matched.events?.[0]?.slug;
                    }
                }
            } catch (_err: unknown) {
                // Poursuite vers Slug
            }
        }

        // 4. Appel Gamma API par slug (Events puis Markets)
        if (
            (!resolvedDate || !resolvedEventSlug) &&
            marketSlug &&
            !IGNORED_MARKET_SLUGS.has(marketSlug)
        ) {
            try {
                const eventRes = await fetch(
                    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(marketSlug)}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (eventRes.ok) {
                    const eventList = (await eventRes.json()) as Array<{
                        slug?: string;
                        endDate?: string;
                        endDateIso?: string;
                        markets?: Array<{ endDate?: string; endDateIso?: string }>;
                    }>;
                    const ev = eventList[0];
                    resolvedDate ??=
                        ev?.endDate ||
                        ev?.endDateIso ||
                        ev?.markets?.[0]?.endDate ||
                        ev?.markets?.[0]?.endDateIso;
                    resolvedEventSlug ??= ev?.slug || marketSlug;
                }
            } catch (_err: unknown) {
                // Ignoré
            }

            if (!resolvedDate || !resolvedEventSlug) {
                try {
                    const marketRes = await fetch(
                        `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`,
                        { signal: AbortSignal.timeout(5000) }
                    );
                    if (marketRes.ok) {
                        const marketList = (await marketRes.json()) as Array<{
                            endDate?: string;
                            endDateIso?: string;
                            events?: Array<{ slug?: string }>;
                        }>;
                        resolvedDate ??= marketList[0]?.endDate || marketList[0]?.endDateIso;
                        resolvedEventSlug ??= marketList[0]?.events?.[0]?.slug;
                    }
                } catch (_err: unknown) {
                    // Ignoré
                }
            }
        }

        if (resolvedDate || resolvedEventSlug) {
            this.cache.set(conditionId, {
                date: resolvedDate || "",
                eventSlug: resolvedEventSlug,
                timestamp: Date.now(),
            });
            return { endDate: resolvedDate, eventSlug: resolvedEventSlug };
        }

        this.cache.set(conditionId, { date: "", timestamp: Date.now() });
        return {};
    }

    async resolveMarketEndDate(
        conditionId: string,
        marketSlug?: string,
        assetAddress?: string
    ): Promise<string | undefined> {
        const meta = await this.resolveMarketMetadata(conditionId, marketSlug, assetAddress);
        return meta.endDate;
    }
}
