import { Controller, Get } from "@nestjs/common";
import type { GlobalMetrics, PerformancePoint } from "./metrics.service.ts";
import { MetricsService } from "./metrics.service.ts";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  async getMetrics(): Promise<GlobalMetrics> {
    return await this.metricsService.getMetrics();
  }

  @Get("performance-history")
  async getPerformanceHistory(): Promise<PerformancePoint[]> {
    return await this.metricsService.getPerformanceHistory();
  }
}
