import type { IncomingMessage } from "node:http";
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { WebSocket, WebSocketServer } from "ws";

@Injectable()
export class EventsGateway implements OnModuleInit, OnModuleDestroy {
    private wss: WebSocketServer | null = null;
    private readonly port = Number(Deno.env.get("WS_PORT")) || 3001;
    private readonly botSockets = new Set<WebSocket>();
    private readonly botPresenceListeners = new Set<(isOnline: boolean) => void>();
    private readonly botVersionListeners = new Set<(version: string | null) => void>();
    private botVersion: string | null = null;

    onBotPresenceChange(listener: (isOnline: boolean) => void): void {
        this.botPresenceListeners.add(listener);
    }

    onBotVersionChange(listener: (version: string | null) => void): void {
        this.botVersionListeners.add(listener);
    }

    isBotConnected(): boolean {
        return this.botSockets.size > 0;
    }

    getBotVersion(): string | null {
        return this.botVersion;
    }

    setBotVersion(version: string | null): void {
        const normalized = version?.trim() || null;
        if (this.botVersion !== normalized) {
            this.botVersion = normalized;
            for (const listener of this.botVersionListeners) {
                listener(this.botVersion);
            }
        }
    }

    onModuleInit(): void {
        try {
            this.wss = new WebSocketServer({ port: this.port });
            console.log(`[EventsGateway] WebSocket server listening on port ${this.port}`);

            this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
                socket.send(JSON.stringify({ event: "connected", timestamp: Date.now() }));

                const url = new URL(req.url || "", `http://localhost:${this.port}`);
                const isBotByUrl = url.searchParams.get("role") === "bot";
                const versionFromUrl = url.searchParams.get("version");

                if (isBotByUrl) {
                    if (versionFromUrl) {
                        this.setBotVersion(versionFromUrl);
                    }
                    this.registerBotSocket(socket);
                }

                socket.on("message", (raw: unknown) => {
                    try {
                        const data = JSON.parse(String(raw)) as {
                            event?: string;
                            role?: string;
                            version?: string;
                        };
                        if (data?.event === "bot:identify" || data?.role === "bot") {
                            if (typeof data.version === "string" && data.version.trim()) {
                                this.setBotVersion(data.version);
                            }
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
            console.log(
                `[EventsGateway] Bot connecté via WebSocket (actifs: ${this.botSockets.size})`
            );
            if (wasEmpty) {
                for (const listener of this.botPresenceListeners) {
                    listener(true);
                }
            }
        }
    }

    private unregisterBotSocket(socket: WebSocket): void {
        if (this.botSockets.has(socket)) {
            this.botSockets.delete(socket);
            console.log(
                `[EventsGateway] Bot déconnecté du WebSocket (actifs: ${this.botSockets.size})`
            );
            if (this.botSockets.size === 0) {
                for (const listener of this.botPresenceListeners) {
                    listener(false);
                }
            }
        }
    }

    onModuleDestroy(): void {
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
    }

    sendToBots(event: string, payload: unknown): boolean {
        if (this.botSockets.size === 0) return false;
        const message = JSON.stringify({ event, data: payload, timestamp: Date.now() });
        let sentCount = 0;
        for (const client of this.botSockets) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
                sentCount++;
            }
        }
        return sentCount > 0;
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
