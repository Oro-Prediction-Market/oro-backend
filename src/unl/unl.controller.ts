import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import {
  UnlService,
  UnlStandings,
  UnlStats,
  UnlSeasonInfo,
} from "./unl.service";

/**
 * Public read-only endpoints — Nations League reference data. No auth.
 *
 * Mirrors `/epl/*` and `/ucl/*` so the app's hub code is the same shape, with
 * one difference worth knowing: these are served straight from our own
 * database rather than a cached provider response, so they are always current.
 * See UnlService for why nothing here is cached.
 */
@ApiTags("unl")
@Controller("unl")
export class UnlController {
  constructor(private readonly unl: UnlService) {}

  @Get("standings")
  @ApiOperation({
    summary: "Nations League group tables (A–N), computed from entered results",
  })
  @ApiQuery({
    name: "season",
    required: false,
    description: 'Edition, e.g. "2026-27". Defaults to the latest one entered.',
  })
  getStandings(@Query("season") season?: string): Promise<UnlStandings> {
    return this.unl.getStandings(season?.trim() || undefined);
  }

  @Get("stats")
  @ApiOperation({
    summary: "Nations League player leaderboards: goals, assists (admin-entered)",
  })
  getStats(): Promise<UnlStats> {
    return this.unl.getStats();
  }

  @Get("season")
  @ApiOperation({
    summary: "Edition status: started?, first kickoff, matchdays played, group and team counts",
  })
  getSeason(): Promise<UnlSeasonInfo> {
    return this.unl.getSeasonInfo();
  }
}
