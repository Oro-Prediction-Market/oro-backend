# Oro Keeperbot Implementation Guide

This guide describes how to implement automated "Keepers" (Bots) in the Oro backend. Keepers are background tasks that monitor market states and trigger lifecycle events (Watch, Detect, Act).

## 1. Architecture Overview

Oro uses **NestJS** and the **`@nestjs/schedule`** package to manage background automation.

- **Watch**: The bot polls the database (e.g., Every minute).
- **Detect**: The bot evaluates conditions (e.g., `closesAt < now`).
- **Act**: The bot calls a service method (e.g., `marketsService.transition(id, 'closed')`).

## 2. Setup

First, install the scheduling package in the backend:

```bash
cd backend
npm install @nestjs/schedule
```

Then, initialize it in `AppModule`:

```typescript
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // ... modules
  ],
})
export class AppModule {}
```

## 3. Creating a Keeper

Create a new service: `backend/src/markets/keeper.service.ts`.

### Example: Market Expiry Keeper
This keeper automatically closes markets once their deadline is reached.

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MarketsService } from './markets.service';
import { MarketStatus } from '../entities/market.entity';

@Injectable()
export class KeeperService {
  private readonly logger = new Logger(KeeperService.name);

  constructor(private readonly marketsService: MarketsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleMarketExpirations() {
    this.logger.debug('Running Expiry Keeper...');
    
    // 1. Fetch all OPEN markets
    const markets = await this.marketsService.findAll();
    const openMarkets = markets.filter(m => m.status === MarketStatus.OPEN);

    for (const market of openMarkets) {
      // 2. Detect expiration
      if (new Date() > new Date(market.closesAt)) {
        this.logger.log(`Market ${market.id} expired. Closing...`);
        
        // 3. Act
        await this.marketsService.transition(market.id, MarketStatus.CLOSED);
      }
    }
  }
}
```

## 4. Advanced: Liquidity Bot (Demo Mode)

For a vibrant demo, you can add a bot that places small random bets to shift the odds dynamically.

```typescript
@Cron(CronExpression.EVERY_5_MINUTES)
async simulateMarketActivity() {
  this.logger.debug('Running Liquidity Bot...');
  
  const markets = await this.marketsService.findAll();
  const activeMarkets = markets.filter(m => m.status === MarketStatus.OPEN);

  for (const market of activeMarkets) {
    // Randomly pick an outcome and place a small bet
    const outcome = market.outcomes[Math.floor(Math.random() * market.outcomes.length)];
    const amount = 0.5 + Math.random() * 2; // 0.5 - 2.5 TON

    await this.marketsService.placeBet('bot-user-id', market.id, {
      outcomeId: outcome.id,
      amount
    });
  }
}
```

## 5. Registration

Don't forget to register the `KeeperService` in your `MarketsModule` providers!

```typescript
@Module({
  providers: [MarketsService, ParimutuelEngine, KeeperService],
  // ...
})
export class MarketsModule {}
```
