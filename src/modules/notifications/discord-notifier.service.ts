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

  constructor() {
    this.webhookUrl =
      Deno.env.get("DISCORD_CLOSED_POSITIONS_WEBHOOK_URL") ||
      Deno.env.get("DISCORD_SELL_WEBHOOK_URL") ||
      Deno.env.get("DISCORD_WEBHOOK_URL") ||
      undefined;
  }

  async sendClosedPositionAlert(position: OpenPosition, targetAlias?: string): Promise<void> {
    if (!this.webhookUrl) return;

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
