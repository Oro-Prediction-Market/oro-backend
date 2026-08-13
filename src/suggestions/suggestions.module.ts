import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MarketSuggestion } from "../entities/market-suggestion.entity";
import { MarketSuggestionVote } from "../entities/market-suggestion-vote.entity";
import { User } from "../entities/user.entity";
import { TelegramModule } from "../telegram/telegram.module";
import { SuggestionsController } from "./suggestions.controller";
import { SuggestionsService } from "./suggestions.service";
import { SuggestionsGateway } from "./suggestions.gateway";

@Module({
  imports: [
    TypeOrmModule.forFeature([MarketSuggestion, MarketSuggestionVote, User]),
    // Circular by nature: we send the approval DM through Telegram, and the bot
    // calls back into this service when the admin taps a button.
    forwardRef(() => TelegramModule),
  ],
  controllers: [SuggestionsController],
  providers: [SuggestionsService, SuggestionsGateway],
  exports: [SuggestionsService],
})
export class SuggestionsModule {}
