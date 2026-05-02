# Oro Documentation

Welcome to the Oro betting platform documentation.

## Quick Start Guides

### For Developers

- **[LMSR Integration Guide](./LMSR-Integration-Guide.md)** ⭐ START HERE
  - Step-by-step implementation for Oro
  - Code examples using actual Oro files
  - Database migrations
  - Testing checklist
  - Deployment guide

### Reference Documentation

- **[LMSR Theory & Mathematics](./LMSR-Guide.md)**
  - Mathematical foundations
  - Formula explanations
  - Worked examples
  - Edge cases and considerations

## Project Structure

```
/backend
  /src
    /markets
      parimutuel.engine.ts  ← Current betting engine
      lmsr.service.ts       ← Add this (see integration guide)
    /entities
      market.entity.ts      ← Market data model
      outcome.entity.ts     ← Update with lmsrProbability
      bet.entity.ts         ← Bet records

/frontend
  /src
    /tma/pages
      MarketsPage.tsx       ← Market list
      MarketDetailPage.tsx  ← Market details + payment options
      DKBankBetPage.tsx     ← Update to show LMSR odds
    config.ts               ← App configuration

/docs
  LMSR-Integration-Guide.md ← Implementation guide (you are here)
  LMSR-Guide.md            ← Theory and math
```

## Current System

### Parimutuel Betting

Oro currently uses traditional parimutuel (pool-based) betting:

- Users bet on outcomes (e.g., "Thimphu Tigers" vs "Paro Panthers")
- Bets accumulate in pools per outcome
- Odds = (Total Pool × (1 - House Edge)) / Outcome Pool
- Winners split the payout pool proportionally

### Payment Methods

1. **DK Bank (Druk PNB)** - Primary for Bhutanese users (BTN currency)
2. **TON Wallet** - Cryptocurrency option
3. **Credits** - Virtual currency for testing

## Proposed Enhancement: LMSR Display

### Problem

Current parimutuel odds:

- ❌ Undefined before first bet (0/0 division)
- ❌ Extreme swings after early bets
- ❌ Poor user experience

### Solution

Add LMSR (Logarithmic Market Scoring Rule) for odds display:

- ✅ Always-defined probabilities
- ✅ Smooth transitions
- ✅ Better UX
- ✅ **No change to settlement** (keeps parimutuel)

## Implementation Status

- [ ] Backend: Add `LMSRService`
- [ ] Database: Add `lmsrProbability` column
- [ ] Engine: Update `ParimutuelEngine.placeBet()`
- [ ] Frontend: Display LMSR probabilities
- [ ] Testing: Unit + integration tests
- [ ] Deployment: Migration + rollout

See **[LMSR Integration Guide](./LMSR-Integration-Guide.md)** for detailed steps.

## Key Concepts

### Hybrid Approach

```
Display Layer:    LMSR probabilities (smooth, always defined)
                  ↓
Storage Layer:    Both LMSR + Parimutuel odds
                  ↓
Settlement Layer: Parimutuel formula (pool redistribution)
```

### No Breaking Changes

- ✅ Existing bets work the same
- ✅ Settlement formula unchanged
- ✅ Payouts calculated identically
- ✅ Can disable LMSR anytime

## Development Workflow

1. **Read** the integration guide
2. **Implement** LMSRService
3. **Update** database schema
4. **Modify** ParimutuelEngine
5. **Test** locally
6. **Deploy** with migration
7. **Monitor** production

## Example: Before & After

### Before (Current)

```
Market: "Tigers vs Panthers"
Pool: 0 BTN

User 1 bets 100 BTN on Tigers
→ Odds: Undefined (0/0) ❌

User 2 bets 50 BTN on Panthers
→ Tigers: 3.00x, Panthers: 1.00x 🎢
```

### After (With LMSR)

```
Market: "Tigers vs Panthers"
Pool: 0 BTN
→ Display: 50% / 50% ✅

User 1 bets 100 BTN on Tigers
→ Display: 55% / 45% ✅

User 2 bets 50 BTN on Panthers
→ Display: 52% / 48% ✅

Settlement: Still uses parimutuel pool ✅
```

## Support

- **Code Issues**: Check `/backend/src/markets/`
- **Database**: See `/backend/src/entities/`
- **Math Questions**: Read `LMSR-Guide.md`
- **Implementation Help**: Follow `LMSR-Integration-Guide.md`

## Resources

### Internal

- [Frontend Config](../frontend/src/config.ts)
- [Parimutuel Engine](../backend/src/markets/parimutuel.engine.ts)
- [Market Entity](../backend/src/entities/market.entity.ts)

### External

- [LMSR Paper by Robin Hanson](https://hanson.gmu.edu/mktscore.pdf)
- [Prediction Markets Handbook](https://www.prediction-markets.com)
- [NestJS Documentation](https://docs.nestjs.com)
- [TypeORM Migrations](https://typeorm.io/migrations)

---

_Oro v1.0 - Bhutanese Archery Betting Platform_  
_Last updated: March 23, 2026_
