import { Injectable } from "@nestjs/common";
import {
  buildClosedPositionEmbed,
  buildClosedPositionsSummaryEmbed,
  type ClosedPositionsSummary,
  type OpenPosition,
} from "@polymarket-copy/shared";

@Injectable()
export class DiscordNotifierService {
  private readonly webhookUrl?: string;
  private readonly notifiedPositions = new Map<string, number>();
  private readonly dedupTtlMs = 10 * 60 * 1000; // 10 minutes

  constructor() {
    this.webhookUrl =
      Deno.env.get("DISCORD_CLOSED_POSITIONS_WEBHOOK_URL") ||
      Deno.env.get("DISCORD_SELL_WEBHOOK_URL") ||
      Deno.env.get("DISCORD_WEBHOOK_URL") ||
      undefined;
  }

  private cleanExpiredDedupEntries(now: number): void {
    for (const [key, timestamp] of this.notifiedPositions.entries()) {
      if (now - timestamp > this.dedupTtlMs) {
        this.notifiedPositions.delete(key);
      }
    }
  }

  async sendClosedPositionAlert(position: OpenPosition, targetAlias?: string): Promise<void> {
    if (!this.webhookUrl) return;

    const dedupKey = position.id || position.conditionId;
    const now = Date.now();
    this.cleanExpiredDedupEntries(now);

    if (dedupKey && this.notifiedPositions.has(dedupKey)) {
      console.log(`[DiscordNotifier] Alerte clôture ignorée (doublon dédupliqué): ${dedupKey}`);
      return;
    }

    if (dedupKey) {
      this.notifiedPositions.set(dedupKey, now);
    }

    try {
      const payload = buildClosedPositionEmbed(position, targetAlias);
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        console.warn(`[DiscordNotifier] Erreur réponse webhook: HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      console.warn("[DiscordNotifier] Échec d'envoi du webhook Discord:", err);
    }
  }

  async sendSummaryAlert(summary: ClosedPositionsSummary): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const payload = buildClosedPositionsSummaryEmbed(summary);
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        console.warn(`[DiscordNotifier] Erreur réponse webhook: HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      console.warn("[DiscordNotifier] Échec d'envoi du webhook Discord:", err);
    }
  }
}
