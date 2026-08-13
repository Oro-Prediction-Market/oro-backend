import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards";
import { SuggestionsService } from "./suggestions.service";
import { CreateSuggestionDto } from "./dto/create-suggestion.dto";
import { MarketCategory } from "../entities/market.entity";

@ApiTags("suggestions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("suggestions")
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get()
  @ApiOperation({ summary: "Approved market suggestions, most-voted first" })
  async list(@Request() req: any) {
    return this.suggestions.listVisible(req.user.userId);
  }

  @Get("quota")
  @ApiOperation({ summary: "Whether the caller may suggest a market this month" })
  async quota(@Request() req: any) {
    return this.suggestions.getQuota(req.user.userId);
  }

  @Post()
  @ApiOperation({
    summary: "Suggest a market (one per calendar month, super-admin approved)",
  })
  async create(@Request() req: any, @Body() dto: CreateSuggestionDto) {
    return this.suggestions.create(
      req.user.userId,
      dto.title,
      dto.description ?? null,
      dto.category ?? MarketCategory.OTHER,
    );
  }

  @Post(":id/vote")
  @HttpCode(200)
  @ApiOperation({ summary: "Cast your single vote for a suggestion" })
  async vote(@Request() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.suggestions.vote(id, req.user.userId);
  }
}
