import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard, JwtAuthGuard } from "../auth/guards";
import { PerfRecorderService } from "./perf-recorder.service";

@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin/perf")
export class PerfController {
  constructor(private readonly perf: PerfRecorderService) {}

  @Get()
  @ApiOperation({
    summary:
      "Request latency per route across all pods (p50/p95/p99 from fixed buckets)",
  })
  async summary(@Query("minutes") minutes?: string) {
    const span = Number(minutes) || 60;
    return {
      minutes: span,
      pool: this.perf.poolStats(),
      routes: await this.perf.summary(span),
    };
  }
}
