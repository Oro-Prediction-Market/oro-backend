import { Global, Module } from "@nestjs/common";
import { JobHealthService } from "./job-health.service";

/**
 * Global so any job can record its health without every module that owns a
 * cron having to import this one.
 */
@Global()
@Module({
  providers: [JobHealthService],
  exports: [JobHealthService],
})
export class JobHealthModule {}
