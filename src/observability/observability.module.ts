import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { PerfController } from "./perf.controller";
import { PerfRecorderService } from "./perf-recorder.service";
import { RequestTimingMiddleware } from "./request-timing.middleware";

/** Request timing and the admin view of it. RedisModule is global. */
@Module({
  controllers: [PerfController],
  providers: [PerfRecorderService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestTimingMiddleware).forRoutes("{*path}");
  }
}
