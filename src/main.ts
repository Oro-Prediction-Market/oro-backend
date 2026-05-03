import "reflect-metadata";
import * as dotenv from "dotenv";
// Set Bhutan timezone (UTC+6) before anything else
process.env.TZ = "Asia/Thimphu";
import { NestFactory, HttpAdapterHost } from "@nestjs/core";
import { ValidationPipe, HttpException, Logger } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { BaseExceptionFilter } from "@nestjs/core";
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";

// Load environment variables
dotenv.config();

/** Suppress noisy 401/403 ERROR logs — these are expected (unauthenticated requests)
 *  and should be logged at DEBUG level, not ERROR. */
@Catch(HttpException)
class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("HTTP");
  catch(exception: HttpException, host: ArgumentsHost) {
    const status = exception.getStatus();
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();
    if (status === 401 || status === 403) {
      this.logger.debug(`[${status}] ${req.method} ${req.url}`);
    } else if (status >= 500) {
      this.logger.error(
        `[${status}] ${req.method} ${req.url} — ${exception.message}`,
      );
    } else {
      this.logger.warn(
        `[${status}] ${req.method} ${req.url} — ${exception.message}`,
      );
    }
    res.status(status).json(exception.getResponse());
  }
}

// Load environment variables
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers
  app.use(helmet());

  // CORS
  const isProduction = process.env.NODE_ENV === "production";
  const allowedOrigins: (string | RegExp)[] = [
    "https://tara-parimutuel.vercel.app",
  ];
  if (!isProduction) {
    allowedOrigins.push(
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://127.0.0.1:5174",
    );
    // Allow an explicit ngrok URL set in .env (DEV_NGROK_URL=https://xxxx.ngrok-free.app)
    // — no wildcard regex; each tunnel URL must be explicitly opted in
    const devNgrok = process.env.DEV_NGROK_URL;
    if (devNgrok) allowedOrigins.push(devNgrok);
  }
  // CORS_ORIGIN: comma-separated list of allowed https origins.
  // Configured in k8s/apps/_shared/configmap.yaml as oro-config.CORS_ORIGIN.
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    for (const raw of corsOrigin
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      try {
        const parsed = new URL(raw);
        if (
          parsed.protocol === "https:" &&
          !allowedOrigins.includes(parsed.origin)
        ) {
          allowedOrigins.push(parsed.origin);
        }
      } catch {
        console.warn(`CORS_ORIGIN entry invalid: ${raw}`);
      }
    }
  }
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  // Global API prefix — all routes are /api/*
  app.setGlobalPrefix("api");

  // Suppress noisy 401/403 error logs — expected from unauthenticated requests
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger docs — controlled by SWAGGER_ENABLED env var.
  // Default: enabled in non-prod, disabled in prod (set SWAGGER_ENABLED=true to override).
  const swaggerEnabled = process.env.SWAGGER_ENABLED
    ? process.env.SWAGGER_ENABLED === "true"
    : !isProduction;
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle("Oro Parimutuel API")
      .setDescription("Parimutuel prediction engine for Telegram Mini App")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("docs", app, document);
    console.log("📖 Swagger docs enabled at /docs");
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 Oro backend running on http://localhost:${port}`);
  console.log(`📖 Swagger docs: http://localhost:${port}/docs`);
}
bootstrap();
