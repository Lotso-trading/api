import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { AppModule } from "./app.module.ts";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter.ts";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor.ts";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, new ExpressAdapter(), {
    logger: ["error", "warn", "log"],
  });

  app.enableCors({
    origin: "*",
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
  });

  app.setGlobalPrefix("api");
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  const port = Number(Deno.env.get("API_PORT")) || 3000;
  const host = Deno.env.get("API_HOST") || "0.0.0.0";

  await app.listen(port, host);
  console.log(`[Polymarket API] NestJS server running on http://${host}:${port}/api`);
}

if (import.meta.main) {
  bootstrap().catch((err: unknown) => {
    console.error("[Polymarket API] Fatal error during startup:", err);
  });
}
