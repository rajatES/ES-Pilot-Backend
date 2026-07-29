import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/http-exception.filter";
import { verifyConfig } from "./common/verify-config";
import cookieParser from "cookie-parser";

async function bootstrap() {
  // Validate config BEFORE anything binds a port — a bad deploy should fail
  // loudly here, not as a 500 on every authenticated request.
  verifyConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  // Raise the JSON body limit so the Design Template image-derive endpoint can
  // accept a base64 data URL (Express defaults to 100kb).
  app.useBodyParser("json", { limit: "12mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "12mb" });

  // Match the original Next.js API surface: every route was served under /api/*.
  // Keeping the prefix means the frontend only has to swap the origin, not paths.
  app.setGlobalPrefix("api");

  // Canva's PKCE OAuth flow stores its verifier/state in short-lived cookies on
  // this (backend) origin between /auth/canva/start and /auth/canva/callback.
  app.use(cookieParser());

  // The frontend lives on a different origin now and sends the Supabase session
  // token as a Bearer header (not a cookie), so we don't need credentials:true —
  // just allow the configured web origins to call us.
  const origins = (process.env.CORS_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    // Cache the CORS preflight for 24h. Without this the browser re-runs the
    // OPTIONS handshake before EVERY mutation, doubling the round-trips a
    // publish/delete/reschedule pays. (Chrome caps this at 2h regardless.)
    maxAge: 86400,
  });

  // Render errors as { error: "<message>" } to match the original API contract.
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = Number(process.env.PORT) || 4000;
  await app.listen(port);
  Logger.log(`Backend API listening on http://localhost:${port}/api`, "Bootstrap");
}

bootstrap();
