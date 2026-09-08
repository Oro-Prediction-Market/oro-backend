import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/guards";
import { ProbabilityHistoryService } from "./probability-history.service";
import { AnswerService } from "./answer.service";

/**
 * The read-only, no-login face of Oro.
 *
 * Every route here is public on purpose. This is the half of the product that
 * answers a question for someone who has no account, no balance and no
 * intention of staking anything — and it is what makes an Oro link worth
 * sending to someone.
 */
@ApiTags("insights")
@Controller("insights")
export class InsightsController {
  constructor(
    private readonly history: ProbabilityHistoryService,
    private readonly answers: AnswerService,
  ) {}

  @Get("markets/:id/history")
  @Public()
  @ApiOperation({
    summary:
      "Probability curve for one market, per outcome, oldest point first. " +
      "Ends at the live probability.",
  })
  @ApiQuery({
    name: "hours",
    required: false,
    description: "Window size in hours (default 720 = 30 days, max 8760)",
  })
  async getHistory(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("hours") hours?: string,
  ) {
    const parsed = hours ? Number(hours) : undefined;
    return this.history.getHistory(id, {
      hours: Number.isFinite(parsed) ? parsed : undefined,
    });
  }

  @Get("movers")
  @Public()
  @ApiOperation({
    summary:
      "Biggest probability moves in the window — one row per market, largest first.",
  })
  @ApiQuery({ name: "hours", required: false, description: "Default 24" })
  @ApiQuery({ name: "limit", required: false, description: "Default 10, max 50" })
  async getMovers(
    @Query("hours") hours?: string,
    @Query("limit") limit?: string,
  ) {
    const h = hours ? Number(hours) : undefined;
    const l = limit ? Number(limit) : undefined;
    return this.history.getMovers({
      hours: Number.isFinite(h) ? h : undefined,
      limit: Number.isFinite(l) ? l : undefined,
    });
  }

  @Get("answer/:id")
  @Public()
  @ApiOperation({
    summary:
      'The public answer to one question — "Oro says 73%", the curve that got ' +
      "there, what will decide it, and the evidence if it is settled.",
  })
  async getAnswer(@Param("id", ParseUUIDPipe) id: string) {
    return this.answers.getAnswer(id);
  }
}
