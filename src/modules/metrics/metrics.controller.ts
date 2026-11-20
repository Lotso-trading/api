import {
    type PeriodSummaryQueryParsed,
    PeriodSummaryQuerySchema,
    type PeriodSummaryResponse,
} from "@lotso-trading/shared";
import { Controller, Get, Query } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe.ts";
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

    @Get("period-summary")
    async getPeriodSummary(
        @Query(new ZodValidationPipe(PeriodSummaryQuerySchema)) query: PeriodSummaryQueryParsed
    ): Promise<PeriodSummaryResponse> {
        return await this.metricsService.getPeriodSummary(query);
    }
}
