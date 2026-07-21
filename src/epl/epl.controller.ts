import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { EplService, EplStandings, EplStats } from "./epl.service";

// Public read-only endpoints — league reference data (standings + player stats)
// sourced from football-data.org and the free FPL API, cached server-side. No auth.
@ApiTags("epl")
@Controller("epl")
export class EplController {
  constructor(private readonly epl: EplService) {}

  @Get("standings")
  @ApiOperation({ summary: "Live England Premier League table (cached 1h)" })
  getStandings(): Promise<EplStandings> {
    return this.epl.getStandings();
  }

  @Get("stats")
  @ApiOperation({
    summary: "Live EPL player leaderboards: goals, assists, yellow, red (cached 1h)",
  })
  getStats(): Promise<EplStats> {
    return this.epl.getStats();
  }

  @Get("season")
  @ApiOperation({
    summary: "Current season status: started?, season start date, gameweeks played",
  })
  getSeason(): Promise<{ started: boolean; seasonStart: string | null; maxPlayed: number }> {
    return this.epl.getSeasonInfo();
  }
}
