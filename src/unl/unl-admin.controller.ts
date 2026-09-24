import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import { AuditLog, AuditAction, RoleType } from "../entities/audit-log.entity";
import { UnlService } from "./unl.service";
import { UnlFixture } from "../entities/unl-fixture.entity";

/**
 * Admin endpoints for the Nations League.
 *
 * A separate file rather than more of `admin.controller.ts`, which is already
 * past 3,800 lines. Same class-level guards.
 *
 * The flow this file exists to support, in order:
 *
 *   1. Enter the 54 teams, grouped A–N.
 *   2. Enter the fixtures. The group tables become correct here, with no
 *      markets in play at all.
 *   3. Create markets for a window of upcoming fixtures.
 *   4. After a match, enter the score. **Nothing happens to the market** —
 *      that is what makes a typo free to fix.
 *   5. Press Propose. The objection window opens.
 *   6. Resolve through the existing /admin/markets/:id/resolve, which already
 *      requires evidence.
 *
 * Steps 4 and 5 are separate on purpose, and nothing between them is
 * automatic: `unl-manual` is excluded from both auto-settlers
 * (settlement-sources.util.ts), so an expired objection window does not settle
 * anything by itself.
 */
@ApiTags("admin-unl")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin/unl")
export class UnlAdminController {
  constructor(
    private readonly unl: UnlService,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  // ── Overview ─────────────────────────────────────────────────────────────

  @Get("season")
  @ApiOperation({ summary: "Edition status, group and team counts" })
  getSeason() {
    return this.unl.getSeasonInfo();
  }

  // ── Teams ────────────────────────────────────────────────────────────────

  @Get("teams")
  @ApiOperation({ summary: "All teams for an edition, grouped A–N" })
  listTeams(@Query("season") season?: string) {
    return this.unl.listTeams(season?.trim() || undefined);
  }

  @Post("teams")
  @ApiOperation({ summary: "Add a nation to a group" })
  async createTeam(
    @Request() req: any,
    @Body()
    body: {
      season?: string;
      groupKey?: string;
      name?: string;
      flagUrl?: string | null;
      sortOrder?: number;
    },
  ) {
    const team = await this.unl.createTeam({
      season: body?.season ?? "",
      groupKey: body?.groupKey ?? "",
      name: body?.name ?? "",
      flagUrl: body?.flagUrl ?? null,
      sortOrder: body?.sortOrder,
    });
    await this.audit(req, AuditAction.MARKET_CREATE, "unl_team", team.id, {
      season: team.season,
      groupKey: team.groupKey,
      name: team.name,
    });
    return team;
  }

  /**
   * Create a whole draw from a pasted block.
   *
   * Pass `dryRun: true` for the preview the page shows before committing —
   * this is the one action that writes fifty-odd rows at once, and the names
   * it writes become market outcome labels that cannot be renamed later.
   */
  @Post("teams/bulk")
  @ApiOperation({ summary: "Add a whole draw from pasted text" })
  async bulkCreateTeams(
    @Request() req: any,
    @Body() body: { season?: string; text?: string; dryRun?: boolean },
  ) {
    const dryRun = body?.dryRun === true;
    const result = await this.unl.bulkCreateTeams(
      body?.season ?? "",
      body?.text ?? "",
      dryRun,
    );
    if (!dryRun && result.created > 0) {
      await this.audit(req, AuditAction.MARKET_CREATE, "unl_team", "bulk", {
        season: body?.season,
        created: result.created,
        skipped: result.skipped.length,
      });
    }
    return result;
  }

  @Patch("teams/:id")
  @ApiOperation({ summary: "Edit a nation" })
  async updateTeam(
    @Request() req: any,
    @Param("id") id: string,
    @Body()
    body: {
      name?: string;
      flagUrl?: string | null;
      sortOrder?: number;
      groupKey?: string;
    },
  ) {
    const team = await this.unl.updateTeam(id, body ?? {});
    await this.audit(req, AuditAction.MARKET_UPDATE, "unl_team", team.id, {
      name: team.name,
      groupKey: team.groupKey,
    });
    return team;
  }

  @Delete("teams/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove a nation (only when it has no fixtures)" })
  async deleteTeam(@Request() req: any, @Param("id") id: string) {
    await this.unl.deleteTeam(id);
    await this.audit(req, AuditAction.MARKET_UPDATE, "unl_team", id, {
      deleted: true,
    });
    return { ok: true };
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────

  /**
   * The fixture list, each row annotated with its market's live state.
   *
   * The annotations are what the page's buttons are driven by: Propose is
   * disabled unless the market is CLOSED, and there is no button at all until
   * a market exists. Computing that here keeps the rule in one place instead
   * of restating it in the UI.
   */
  @Get("fixtures")
  @ApiOperation({ summary: "Fixtures for an edition, with market state" })
  async listFixtures(@Query("season") season?: string) {
    const fixtures = await this.unl.listFixtures(season?.trim() || undefined);
    const markets = await this.unl.marketsByFixture(fixtures);

    return fixtures.map((f) => {
      const market = f.marketId ? markets.get(f.marketId) : undefined;
      const wouldWin = this.unl.outcomeIdForScore(f);
      return {
        ...f,
        market: market
          ? {
              id: market.id,
              title: market.title,
              status: market.status,
              totalPool: Number(market.totalPool),
              proposedOutcomeId: market.proposedOutcomeId ?? null,
              resolvedOutcomeId: market.resolvedOutcomeId ?? null,
              disputeDeadlineAt: market.disputeDeadlineAt ?? null,
            }
          : null,
        /** What a Propose right now would submit, for the confirm dialog. */
        proposedLabel: wouldWin
          ? (market?.outcomes?.find((o) => o.id === wouldWin)?.label ?? null)
          : null,
        canPropose:
          !!market && market.status === "closed" && !!wouldWin && !market.proposedOutcomeId,
      };
    });
  }

  @Post("fixtures")
  @ApiOperation({ summary: "Add a fixture" })
  async createFixture(
    @Request() req: any,
    @Body()
    body: {
      season?: string;
      homeTeamId?: string;
      awayTeamId?: string;
      kickoffAt?: string;
      matchday?: number | null;
    },
  ) {
    const fixture = await this.unl.createFixture({
      season: body?.season ?? "",
      homeTeamId: body?.homeTeamId ?? "",
      awayTeamId: body?.awayTeamId ?? "",
      kickoffAt: body?.kickoffAt ?? "",
      matchday: body?.matchday ?? null,
    });
    await this.audit(req, AuditAction.MARKET_CREATE, "unl_fixture", fixture.id, {
      groupKey: fixture.groupKey,
      kickoffAt: fixture.kickoffAt,
      matchday: fixture.matchday,
    });
    return fixture;
  }

  /**
   * Generate a group's whole fixture list from its teams.
   *
   * The pairings follow from who is in the group, so the only input is when
   * each matchday kicks off. Refused if the group already has fixtures.
   */
  @Post("fixtures/generate")
  @ApiOperation({ summary: "Generate a group's round-robin fixture list" })
  async generateFixtures(
    @Request() req: any,
    @Body()
    body: {
      season?: string;
      groupKey?: string;
      kickoffs?: string[];
      rounds?: number;
    },
  ) {
    const rounds = Number(body?.rounds) === 1 ? 1 : 2;
    const result = await this.unl.generateFixtures(
      body?.season ?? "",
      body?.groupKey ?? "",
      body?.kickoffs ?? [],
      rounds,
    );
    await this.audit(req, AuditAction.MARKET_CREATE, "unl_fixture", "generated", {
      season: body?.season,
      groupKey: body?.groupKey,
      rounds,
      created: result.created,
    });
    return result;
  }

  @Patch("fixtures/:id")
  @ApiOperation({ summary: "Move a kickoff or change a matchday" })
  async updateFixture(
    @Request() req: any,
    @Param("id") id: string,
    @Body() body: { kickoffAt?: string; matchday?: number | null },
  ) {
    const fixture = await this.unl.updateFixture(id, body ?? {});
    await this.audit(req, AuditAction.MARKET_UPDATE, "unl_fixture", fixture.id, {
      kickoffAt: fixture.kickoffAt,
      matchday: fixture.matchday,
    });
    return fixture;
  }

  @Delete("fixtures/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove a fixture (only when it has no market)" })
  async deleteFixture(@Request() req: any, @Param("id") id: string) {
    await this.unl.deleteFixture(id);
    await this.audit(req, AuditAction.MARKET_UPDATE, "unl_fixture", id, {
      deleted: true,
    });
    return { ok: true };
  }

  /**
   * Enter or correct a full-time score.
   *
   * Has no effect on any market — see UnlService.setScore. The `warning` in the
   * response is the one case that needs a human: a score that now contradicts
   * a market which has already settled.
   */
  @Put("fixtures/:id/score")
  @ApiOperation({ summary: "Enter or correct a score (no market side effects)" })
  async setScore(
    @Request() req: any,
    @Param("id") id: string,
    @Body()
    body: { homeScore?: number | null; awayScore?: number | null; status?: string },
  ) {
    const before = await this.unl.listFixtures().then((all) => all.find((f) => f.id === id));
    const { fixture, warning } = await this.unl.setScore(id, {
      homeScore: body?.homeScore ?? null,
      awayScore: body?.awayScore ?? null,
      status: body?.status,
    });
    await this.audit(
      req,
      AuditAction.MARKET_UPDATE,
      "unl_fixture",
      fixture.id,
      {
        score: `${fixture.homeScore}-${fixture.awayScore}`,
        status: fixture.status,
        warning,
      },
      before ? { score: `${before.homeScore}-${before.awayScore}` } : undefined,
    );
    return { fixture, warning };
  }

  // ── Markets ──────────────────────────────────────────────────────────────

  @Post("fixtures/:id/market")
  @ApiOperation({ summary: "Create this fixture's match market" })
  async createMarket(@Request() req: any, @Param("id") id: string) {
    const market = await this.unl.createMarketForFixture(id);
    await this.audit(req, AuditAction.MARKET_CREATE, "market", market.id, {
      title: market.title,
      subcategory: market.subcategory,
      unlFixtureId: id,
      closesAt: market.closesAt,
    });
    return market;
  }

  @Post("markets/window")
  @ApiOperation({
    summary: "Create markets for every fixture kicking off within N days",
  })
  async createWindow(
    @Request() req: any,
    @Body() body: { days?: number },
  ) {
    const days = Math.min(Math.max(Number(body?.days ?? 7), 1), 60);
    const result = await this.unl.createMarketsForWindow(days);
    await this.audit(req, AuditAction.MARKET_CREATE, "market", "bulk", {
      days,
      created: result.created.length,
      skipped: result.skipped.length,
    });
    return result;
  }

  /**
   * Propose this fixture's result.
   *
   * The winner comes from the outcome ids stored on the fixture row when the
   * market was created — a comparison of two integers, with no team name
   * anywhere in the path. This competition fields Republic of Ireland AND
   * Northern Ireland, so name matching is not a shortcut worth having.
   */
  @Post("fixtures/:id/propose")
  @ApiOperation({ summary: "Propose the result and open the objection window" })
  async propose(
    @Request() req: any,
    @Param("id") id: string,
    @Body() body: { windowMinutes?: number },
  ) {
    const windowMinutes = Number(body?.windowMinutes ?? 60);
    const result = await this.unl.proposeFixtureResult(id, windowMinutes);
    await this.audit(
      req,
      AuditAction.MARKET_TRANSITION,
      "market",
      result.marketId,
      {
        proposed: result.outcomeLabel,
        outcomeId: result.outcomeId,
        windowMinutes,
        via: "unl-fixture-row",
      },
    );
    return result;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Write the audit row directly rather than through AuditService.
   *
   * AuditService is exported by AdminModule, which imports most of the app —
   * pulling it in here to log a team rename would add a module edge for no
   * reason. Same shape as AutoResolveMarketsJob writes, and a failed audit
   * never fails the admin's action.
   */
  private async audit(
    req: any,
    action: AuditAction,
    entityType: string,
    entityId: string,
    after: Record<string, unknown>,
    before?: Record<string, unknown>,
  ): Promise<void> {
    const entry = this.auditRepo.create({
      adminId: req?.user?.userId ?? "unknown",
      username: req?.user?.username,
      roleType: RoleType.ADMIN,
      action,
      entityType,
      entityId,
      payload: { before, after },
      ipAddress: req?.ip,
    });
    await this.auditRepo.save(entry).catch(() => undefined);
  }
}
