import { Module } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module.ts";
import { ConfigModule } from "./modules/config/config.module.ts";
import { EventsModule } from "./modules/gateway/events.module.ts";
import { MetricsModule } from "./modules/metrics/metrics.module.ts";
import { NotificationsModule } from "./modules/notifications/notifications.module.ts";
import { PositionsModule } from "./modules/positions/positions.module.ts";
import { TargetsModule } from "./modules/targets/targets.module.ts";
import { TradesModule } from "./modules/trades/trades.module.ts";

@Module({
  imports: [
    DatabaseModule,
    NotificationsModule,
    EventsModule,
    TargetsModule,
    TradesModule,
    PositionsModule,
    ConfigModule,
    MetricsModule,
  ],
})
export class AppModule {}
