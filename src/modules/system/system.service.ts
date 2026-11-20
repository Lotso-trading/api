import type { ServiceVersions } from "@lotso-trading/shared";
import { Injectable } from "@nestjs/common";
import { EventsGateway } from "../gateway/events.gateway.ts";

function readVersionFromJson(fileUrl: URL, fallback: string): string {
    try {
        const raw = Deno.readTextFileSync(fileUrl);
        const parsed = JSON.parse(raw) as { version?: string; build?: string };
        if (parsed.version) {
            return parsed.version;
        }
    } catch {
        // Fallback silencieux si le fichier n'est pas accessible
    }
    return fallback;
}

@Injectable()
export class SystemService {
    private readonly apiVersion: string;
    private readonly sharedVersion: string;

    constructor(private readonly eventsGateway: EventsGateway) {
        const apiDenoJson = new URL("../../../deno.json", import.meta.url);
        const workspaceSharedDeno = new URL(
            "../../../../../packages/shared/deno.json",
            import.meta.url
        );

        this.apiVersion = Deno.env.get("API_VERSION") || readVersionFromJson(apiDenoJson, "1.0.0");

        let installedSharedVersion = "";
        try {
            const installedSharedPkg = new URL(
                "../package.json",
                import.meta.resolve("@lotso-trading/shared")
            );
            installedSharedVersion = readVersionFromJson(installedSharedPkg, "");
        } catch {
            // Fallback silencieux si la résolution échoue
        }

        this.sharedVersion =
            Deno.env.get("SHARED_VERSION") ||
            installedSharedVersion ||
            readVersionFromJson(workspaceSharedDeno, "1.0.0");

        this.eventsGateway.onBotPresenceChange(() => {
            this.broadcastVersions();
        });

        this.eventsGateway.onBotVersionChange(() => {
            this.broadcastVersions();
        });
    }

    getVersions(): ServiceVersions {
        return {
            api: this.apiVersion,
            bot: this.eventsGateway.getBotVersion(),
            shared: this.sharedVersion,
            botOnline: this.eventsGateway.isBotConnected(),
            updatedAt: Date.now(),
        };
    }

    broadcastVersions(): ServiceVersions {
        const versions = this.getVersions();
        this.eventsGateway.broadcast("system:versions", versions);
        return versions;
    }
}
