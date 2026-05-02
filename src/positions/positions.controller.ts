import { Controller, Get, UseGuards, Request } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { JwtAuthGuard } from "../auth/guards";
import { Position } from "../entities/position.entity";

@ApiTags("bets")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("positions")
export class PositionsController {
  constructor(
    @InjectRepository(Position) private positionRepo: Repository<Position>,
  ) {}

  @Get("my")
  @ApiOperation({ summary: "Get my betting history" })
  myPositions(@Request() req: any) {
    return this.positionRepo.find({
      where: { userId: req.user.userId },
      relations: ["market", "outcome"],
      order: { placedAt: "DESC" },
    });
  }
}
