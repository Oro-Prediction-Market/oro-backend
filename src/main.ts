import "reflect-metadata";
import * as dotenv from "dotenv";
import * as bodyParser from "body-parser";
// Set Bhutan timezone (UTC+6) before anything else
process.env.TZ = "Asia/Thimphu";
import { NestFactory, HttpAdapterHost, Reflector } from "@nestjs/core";
import {
  ValidationPipe,
  HttpException,
  Logger,
  ClassSerializerInterceptor,
} from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { DataSource } from "typeorm";
import { BaseExceptionFilter } from "@nestjs/core";
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import helmet from "helmet";
import * as cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./redis/redis-io.adapter";
import { RedisService } from "./redis/redis.service";

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
  // ── Body parsing, with raw bytes kept for the 21Pay webhook ────────────────
  //
  // 21Pay's HMAC is computed over the exact bytes it sent. A parse-then-
  // reserialise round trip changes whitespace and key order, so verifying
  // against the parsed body fails for every legitimate delivery.
  //
  // Nest installs its own JSON parser during `create()`, and body-parser skips
  // a request another parser has already consumed — so adding a second parser
  // afterwards silently never runs its `verify`, and `rawBody` is quietly
  // undefined. Hence `bodyParser: false` and one parser we control.
  //
  // The buffer is retained for the webhook path only. Keeping it for every
  // request would double the memory held per request across a live API to
  // serve one route.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // A document photograph is the one payload that legitimately exceeds the
  // general 1 MB ceiling: base64 inflates by a third, so the service's 4 MB
  // image limit needs roughly 5.5 MB of JSON. Mounted first and scoped to the
  // one path — body-parser skips a request already consumed, so the general
  // parser below leaves it alone, and every other route keeps the tighter
  // limit rather than the whole API inheriting a 6 MB request budget.
  app.use("/api/kyc/documents", bodyParser.json({ limit: "6mb" }));

  const WEBHOOK_PATH = "/api/payments/usdt/webhook";
  app.use(
    bodyParser.json({
      limit: "1mb",
      verify: (req: any, _res: unknown, buf: Buffer) => {
        if (req.originalUrl?.split("?")[0] === WEBHOOK_PATH) {
          req.rawBody = buf;
        }
      },
    }),
  );
  app.use(bodyParser.urlencoded({ extended: true, limit: "1mb" }));

  // Migrations: run them here, under a lock, then gate on the result.
  //
  // `DB_MIGRATIONS_RUN=true` makes a deploy self-applying — push, and the new
  // pod brings the schema with it. What TypeORM's own `migrationsRun` does not
  // give you is safety when more than one replica boots at once: each would
  // read the migrations table, both would decide the same migration is
  // pending, and both would try to apply it. One wins, the other dies on a
  // duplicate-object error and crash-loops.
  //
  // A Postgres advisory lock costs one round trip and removes that entirely.
  // The second pod blocks, then finds nothing pending and carries on. The lock
  // is session-scoped, so a pod killed mid-migration releases it when its
  // connection drops rather than wedging every future deploy.
  {
    const log = new Logger("migrations");
    const dataSource = app.get(DataSource);

    if (process.env.DB_MIGRATIONS_RUN === "true") {
      // Arbitrary but fixed: any two processes using the same number
      // serialise against each other, and nothing else in the system uses it.
      const LOCK_ID = 776_199_001;
      const runner = dataSource.createQueryRunner();
      try {
        await runner.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
        const applied = await dataSource.runMigrations({ transaction: "each" });
        if (applied.length) {
          log.log(
            `Applied ${applied.length} migration(s): ${applied
              .map((m) => m.name)
              .join(", ")}`,
          );
        } else {
          log.log("Schema already up to date.");
        }
      } catch (err) {
        // Never start on a half-applied schema — the endpoints most likely to
        // break are the ones that move money.
        log.error(`Migration failed, refusing to start: ${(err as Error).message}`);
        await runner.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
        await runner.release().catch(() => undefined);
        await app.close();
        process.exit(1);
      }
      await runner.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
      await runner.release();
    }

    const pending = await dataSource.showMigrations();
    if (pending) {
      if (process.env.NODE_ENV === "production") {
        log.error(
          "Pending migrations detected — refusing to start. " +
            "Run `npm run migration:run` against this database, then redeploy.",
        );
        await app.close();
        process.exit(1);
      }
      log.warn(
        "Pending migrations detected. Run `npm run migration:run` — the schema is behind the entities.",
      );
    }
  }

  // socket.io horizontal scaling: Redis pub/sub adapter so WS broadcasts reach
  // clients across ALL backend pods. Falls back to in-memory if Redis is down
  // (won't block startup).
  try {
    const redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis(app.get(RedisService));
    app.useWebSocketAdapter(redisIoAdapter);
  } catch (e) {
    new Logger("bootstrap").error(
      `Redis IO adapter setup failed; using in-memory adapter: ${(e as Error).message}`,
    );
  }

  // Parse cookies so @Request().cookies is populated (used for httpOnly auth cookie)
  app.use(cookieParser());

  // Security headers — strict CSP for API routes, relaxed for Swagger UI
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith("/docs")) {
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
          },
        },
      })(req, res, next);
    } else {
      helmet()(req, res, next);
    }
  });

  // CORS
  const isProduction = process.env.NODE_ENV === "production";
  // Production origins are set via CORS_ORIGIN env var (comma-separated).
  // See comment below — do not hardcode deployment URLs here.
  const allowedOrigins: (string | RegExp)[] = [];
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

  // Global API prefix — all routes are /api/* except SEO files
  app.setGlobalPrefix("api", { exclude: ["sitemap.xml", "robots.txt"] });

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

  // Global response serialization — strips @Exclude()'d fields (e.g. password
  // and phone-identity hashes on User) from every entity returned by the API,
  // including nested relations (payment.user, transaction.user, dispute.user).
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

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
