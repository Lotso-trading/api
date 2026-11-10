import type { IncomingMessage } from "node:http";
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { WebSocket, WebSocketServer } from "ws";

@Injectable()
export class EventsGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private readonly port = Number(Deno.env.get("WS_PORT")) || 3001;
  private readonly botSockets = new Set<WebSocket>();
  private botPresenceListener: ((isOnline: boolean) => void) | null = null;

  onBotPresenceChange(listener: (isOnline: boolean) => void): void {
    this.botPresenceListener = listener;
  }

  isBotConnected(): boolean {
    return this.botSockets.size > 0;
  }

  onModuleInit(): void {
    try {
      this.wss = new WebSocketServer({ port: this.port });
      console.log(`[EventsGateway] WebSocket server listening on port ${this.port}`);

      this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
        socket.send(JSON.stringify({ event: "connected", timestamp: Date.now() }));

        const url = new URL(req.url || "", `http://localhost:${this.port}`);
        const isBotByUrl = url.searchParams.get("role") === "bot";

        if (isBotByUrl) {
          this.registerBotSocket(socket);
        }

        socket.on("message", (raw: unknown) => {
          try {
            const data = JSON.parse(String(raw)) as { event?: string; role?: string };
            if (data?.event === "bot:identify" || data?.role === "bot") {
              this.registerBotSocket(socket);
            }
          } catch (_err: unknown) {
            // Ignoré
          }
        });

        socket.on("close", () => {
          this.unregisterBotSocket(socket);
        });

        socket.on("error", () => {
          this.unregisterBotSocket(socket);
        });
      });
    } catch (err: unknown) {
      console.warn(`[EventsGateway] Could not bind WebSocket port ${this.port}:`, err);
    }
  }

  private registerBotSocket(socket: WebSocket): void {
    if (!this.botSockets.has(socket)) {
      const wasEmpty = this.botSockets.size === 0;
      this.botSockets.add(socket);
      console.log(`[EventsGateway] Bot connecté via WebSocket (actifs: ${this.botSockets.size})`);
      if (wasEmpty) {
        this.botPresenceListener?.(true);
      }
    }
  }

  private unregisterBotSocket(socket: WebSocket): void {
    if (this.botSockets.has(socket)) {
      this.botSockets.delete(socket);
      console.log(`[EventsGateway] Bot déconnecté du WebSocket (actifs: ${this.botSockets.size})`);
      if (this.botSockets.size === 0) {
        this.botPresenceListener?.(false);
      }
    }
  }

  onModuleDestroy(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  broadcast(event: string, payload: unknown): void {
    if (!this.wss) return;
    const message = JSON.stringify({ event, data: payload, timestamp: Date.now() });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}
