# TER Market Implementation

> Last updated: May 5, 2026

## Overview

TER is a gold-backed digital asset where 1 TER = 0.01g fine gold. Oro runs **15-minute price prediction markets** on TER, auto-resolved via the official TER price API.

---

## Architecture

```
┌─────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│  api.ter.bt     │◄──────│  oro-backend     │──────►│  oro-pwa / tma  │
│  /prices        │       │  TerMarketService│       │  TerMarketCard  │
└─────────────────┘       └──────────────────┘       │  TerPricePanel  │
                                                     └─────────────────┘
```

---

## Backend (`oro-backend`)

### Module: `src/ter/`

| File                    | Role                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `ter.module.ts`         | NestJS module wiring                                                                 |
| `ter.controller.ts`     | REST endpoint `GET /api/ter/price` (public, cached 30s in Redis)                     |
| `ter-price.service.ts`  | Fetches live TER price (primary: api.ter.bt, fallback: XAU/USD × USD/INR derivation) |
| `ter-market.service.ts` | Spawns, closes, and auto-resolves 15-min prediction markets                          |

### API Endpoint: `GET /api/ter/price`

Returns the current TER price (cached 30s in Redis under key `oro:cache:ter:price`):

```json
{
  "midPrice": 140.5933,
  "buyPrice": 140.9933,
  "sellPrice": 140.1933,
  "xauUsd": 2345.67,
  "usdInr": 83.45,
  "fetchedAt": "2026-05-05T10:30:00.000Z"
}
```

### Price Derivation (Fallback)

If `api.ter.bt/prices` is unreachable, price is derived:

```
midPrice = (XAU_USD / 31.1035) × 0.01 × USD_INR
buyPrice = midPrice × 1.0122
sellPrice = midPrice × 0.9878
```

- 1 TER = 0.01g of .9999 fine gold
- Spread: ±1.22%

### Service: `src/ter/ter-market.service.ts`

**Market Lifecycle (15-min rounds):**

1. **Spawn** — A new market is created every 15 minutes
2. **Open** — Users can bet UP or DOWN
3. **Betting closes** — 2 minutes before market close (configurable)
4. **Close** — Market closes, settlement price is fetched
5. **Resolve** — Compares settlement mid-price vs reference mid-price → winner is UP or DOWN

**Title Format:**

```
TER — UP or DOWN in 15 minutes?
```

> ⚠️ Round numbers were intentionally removed from the title. Do NOT add them back.

**Metadata stored on each market:**

```json
{
  "isTer": true,
  "referenceTerPrice": 140.5933, // mid-price at open (used for resolution)
  "referenceBuyPrice": 140.9933, // ask price at open (used for display)
  "referenceSellPrice": 140.1933, // bid price at open
  "settlementTerPrice": 141.2, // mid-price at close (used for resolution)
  "settlementBuyPrice": 141.6, // ask price at close (used for display)
  "settlementSellPrice": 140.8, // bid price at close
  "openXauUsd": 2345.67, // XAU/USD at open (informational)
  "closeXauUsd": 2348.9 // XAU/USD at close (informational)
}
```

**Resolution Logic:**

- Direction is determined by comparing `settlementTerPrice` (mid) vs `referenceTerPrice` (mid)
- If settlement mid > reference mid → **UP wins**
- If settlement mid < reference mid → **DOWN wins**
- If equal → market is voided/cancelled

**Price Source:**

- Endpoint: `https://api.ter.bt/prices`
- Response format:

```json
{
  "prices": [
    {
      "product_symbol": "TERBTN",
      "ask_price": 1409933,
      "bid_price": 1375776,
      "tradeable": true,
      "spread": 34157,
      "effective_at": "2026-05-05T10:30:00Z"
    }
  ]
}
```

- Prices are in **integer format** (multiply by 10000 for display as Nu X.XXXX)
- `ask_price` = buy price, `bid_price` = sell price
- `mid_price` = (ask + bid) / 2

---

## Frontend Display

### TerMarketCard (Market List)

**Location:** `src/components/TerMarketCard.tsx` (both oro-pwa and oro-tma)

**Header:** `TER · 15 Min Price Prediction` (accent color, uppercase)

**Price Display:**

- Shows `Base → Live` when market is open
- Shows `Open → Close` when settled
- Prices displayed as `Nu X.XXXX` (4 decimal places)
- Color: green if UP, red if DOWN
- Centered layout with trend icon

**Sentiment Bar:** Green/red split showing UP/DOWN bet percentages

**Action Buttons:** UP / DOWN (disabled after betting closes)

### TerPricePanel (Market Detail Page)

**Location:** Inline in `PwaMarketDetailPage.tsx` and `MarketDetailPage.tsx` (TMA)

**Header:** `TER · 15 Minute Price Prediction`

**Layout:**

- Open price (left) → Live/Close price (right) with arrow
- Difference badge: `+X.XXXX BTN (+X.XX%)`
- Winner label when settled: `▲ UP won` or `▼ DOWN won`

**Resolution Data Block** (shown only when settled):

- Styled as monospace JSON mimicking `api.ter.bt/prices` response
- Shows: product_symbol, ask_price, bid_price, spread, tradeable, effective_at
- Dark background with syntax-highlighted colors

### Important Display Rules

1. **Description is hidden** for TER markets (`externalSource === "ter"`)
2. **Round numbers are NOT shown** anywhere in the UI
3. **Buy price** is used for user-facing display (matches TER portal convention)
4. **Mid price** is used for resolution logic (objective, unbiased)
5. Live price polling: every 30 seconds via `getTerPrice()` API call

---

## Timezone

All times use **Asia/Thimphu (BTT, UTC+6)**. The `TZ=Asia/Thimphu` env var is set in the backend. Frontend formatting uses `fmtBSTDate()` / `fmtBSTDateTime()` helpers from `bst.ts`.

---

## Database

**Table:** `markets`

Key columns for TER:

- `"externalSource"` = `'ter'`
- `metadata` (JSONB) — contains all price data listed above
- `"bettingClosesAt"` — 2 minutes before `"closesAt"`

**To update all TER titles manually:**

```sql
UPDATE markets SET title = 'TER — UP or DOWN in 15 minutes?' WHERE "externalSource" = 'ter';
```

---

## Common Mistakes to Avoid

| ❌ Don't                                | ✅ Do                                            |
| --------------------------------------- | ------------------------------------------------ |
| Add round numbers to title              | Keep title as `TER — UP or DOWN in 15 minutes?`  |
| Use buy price for resolution            | Use mid price for resolution                     |
| Show description for TER markets        | Hide description when `externalSource === "ter"` |
| Display prices with 2 decimals          | Use 4 decimal places (`toFixed(4)`)              |
| Forget timezone                         | Always use Asia/Thimphu formatting               |
| Compare buy prices for direction        | Compare mid prices for UP/DOWN direction         |
| Use `minWidth` forcing scroll on mobile | Use responsive grid that fits screen             |

---

## File Map

| File                                        | Purpose                                                      |
| ------------------------------------------- | ------------------------------------------------------------ |
| `oro-backend/src/ter/ter.module.ts`         | NestJS module registration                                   |
| `oro-backend/src/ter/ter.controller.ts`     | `GET /api/ter/price` endpoint (public, Redis-cached 30s)     |
| `oro-backend/src/ter/ter-price.service.ts`  | Fetches price from api.ter.bt (fallback: XAU×INR derivation) |
| `oro-backend/src/ter/ter-market.service.ts` | Market spawn, close, auto-resolution (cron every 15min)      |
| `oro-pwa/shared/api/client.ts`              | `getTerPrice()` — calls `/api/ter/price`                     |
| `oro-pwa/src/components/TerMarketCard.tsx`  | PWA market list card (centered price, sentiment bar)         |
| `oro-tma/src/components/TerMarketCard.tsx`  | TMA market list card                                         |
| `oro-pwa/src/pages/PwaMarketDetailPage.tsx` | PWA detail page (includes inline `TerPricePanel` component)  |
| `oro-tma/src/pages/MarketDetailPage.tsx`    | TMA detail page (includes inline `TerPricePanel` component)  |
| `oro-pwa/src/bst.ts` / `oro-tma/src/bst.ts` | Timezone formatting helpers (Asia/Thimphu)                   |

---

## Admin Panel (`oro-admin`)

The admin panel has **no TER-specific UI**. TER markets appear in the generic Market Management table like any other market. They are fully auto-managed by the backend cron — admins do not need to create, close, or resolve them manually.

> TER markets can still be **cancelled** from the admin panel if needed (e.g., API outage). This refunds all bets.
