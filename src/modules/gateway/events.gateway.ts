import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { WebSocket, WebSocketServer } from "ws";

@Injectable()
export class EventsGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private readonly port = Number(Deno.env.get("WS_PORT")) || 3001;

  onModuleInit(): void {
    try {
      this.wss = new WebSocketServer({ port: this.port });
      console.log(`[EventsGateway] WebSocket server listening on port ${this.port}`);

      this.wss.on("connection", (socket: WebSocket) => {
        socket.send(JSON.stringify({ event: "connected", timestamp: Date.now() }));
      });
    } catch (err) {
      console.warn(`[EventsGateway] Could not bind WebSocket port ${this.port}:`, err);
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
