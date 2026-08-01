import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { UclService, UclStandings, UclStats, UclBracket } from "./ucl.service";

// Public read-only endpoints — Champions League reference data (standings +
// player stats) sourced from football-data.org, cached server-side. No auth.
@ApiTags("ucl")
@Controller("ucl")
export class UclController {
  constructor(private readonly ucl: UclService) {}

  @Get("standings")
  @ApiOperation({ summary: "Live UEFA Champions League table (cached 1h)" })
  getStandings(): Promise<UclStandings> {
    return this.ucl.getStandings();
  }

  @Get("stats")
  @ApiOperation({
    summary: "Live UCL player leaderboards: goals, assists (cached 1h)",
  })
  getStats(): Promise<UclStats> {
    return this.ucl.getStats();
  }

  @Get("season")
  @ApiOperation({
    summary: "Current season status: started?, season start date, matchdays played",
  })
  getSeason(): Promise<{ started: boolean; seasonStart: string | null; maxPlayed: number }> {
    return this.ucl.getSeasonInfo();
  }

  @Get("bracket")
  @ApiOperation({
    summary: "Knockout bracket (Round of 16 → Final) built from CL results (cached 1h)",
  })
  getBracket(): Promise<UclBracket> {
    return this.ucl.getBracket();
  }
}
