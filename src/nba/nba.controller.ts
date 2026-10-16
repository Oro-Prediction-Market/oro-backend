import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { NbaGame } from "./espn-nba.util";
import { NbaService, NbaStandings } from "./nba.service";

// Public read-only endpoints — the NBA schedule with live scores and the
// conference standings, from ESPN, cached server-side. No auth, like /epl.
@ApiTags("nba")
@Controller("nba")
export class NbaController {
  constructor(private readonly nba: NbaService) {}

  @Get("games")
  @ApiOperation({
    summary:
      "NBA games by Bhutan date, with live scores (default: yesterday + 8 days)",
  })
  @ApiQuery({
    name: "from",
    required: false,
    description: "YYYY-MM-DD (Bhutan date)",
  })
  @ApiQuery({ name: "days", required: false, description: "1-14, default 9" })
  getGames(
    @Query("from") from?: string,
    @Query("days") days?: string,
  ): Promise<NbaGame[]> {
    if (from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new BadRequestException("from must be YYYY-MM-DD");
    }
    return this.nba.getGames(from, days === undefined ? 9 : Number(days));
  }

  @Get("standings")
  @ApiOperation({
    summary: "NBA conference standings, regular season (cached 30 min)",
  })
  getStandings(): Promise<NbaStandings> {
    return this.nba.getStandings();
  }
}
