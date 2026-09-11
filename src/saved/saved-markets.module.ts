import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SavedMarket } from "../entities/saved-market.entity";
import { Market } from "../entities/market.entity";
import { MarketsModule } from "../markets/markets.module";
import { SavedMarketsController } from "./saved-markets.controller";
import { SavedMarketsService } from "./saved-markets.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([SavedMarket, Market]),
    // For MarketsService.findManyByIds — the saved list is hydrated by the
    // same code as the feed so the same cards can render it.
    MarketsModule,
  ],
  controllers: [SavedMarketsController],
  providers: [SavedMarketsService],
  exports: [SavedMarketsService],
})
export class SavedMarketsModule {}
