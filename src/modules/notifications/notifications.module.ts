import { Global, Module } from "@nestjs/common";
import { DiscordNotifierService } from "./discord-notifier.service.ts";

@Global()
@Module({
  providers: [DiscordNotifierService],
  exports: [DiscordNotifierService],
})
export class NotificationsModule {}
