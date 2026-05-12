# Oro — Auto-Loop Markets Engineering Spec

> Three perpetual market types, auto-created and auto-resolved.
> All times **Bhutan time (BTN, UTC+6)** unless otherwise noted.

---

## Overview

Three loop markets run automatically without admin intervention:

| Market | Cycle | Markets per day | Source |
|---|---|---|---|
| **BTC Higher/Lower** | 15 min | 96 | Binance BTCUSDT |
| **TER Higher/Lower** | 12 hr | 2 | ter.bt portal or Solana DEX |
| **USD/BTN Higher/Lower** | 24 hr (business days only) | ~1 | rma.org.bt |

All three share the same UX pattern:
1. System auto-creates a new market at the scheduled time
2. Reference price is fetched and stamped at open
3. User sees: **"[Asset] in [time] — Higher or Lower than [reference]?"**
4. Betting closes 1 minute before scheduled resolution
5. System auto-fetches resolution price and settles

No admin involvement. No price targets to set. No charts to read.

---

## 1. BTC — 15-minute loop

### Schedule
- New market every 15 minutes, on the quarter hour: `:00`, `:15`, `:30`, `:45`
- Runs 24/7, perpetual

### Lifecycle
| Event | Time |
|---|---|
| Market opens | T+0 |
| Reference price stamped | T+0 |
| Betting closes | T+14:00 |
| Resolution price fetched | T+15:00 |
| Market settled | T+15:00 + few seconds |

### Source
- **API:** `https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT`
- **Reference price:** value of `price` field at market open
- **Resolution price:** value of `price` field at T+15:00

### Market text (auto-generated)

**Title:**
> Bitcoin in 15 minutes — Higher or Lower than $[REF]?

Where `[REF]` = the stamped reference price, e.g. `$98,234`.

**Description (optional, shown on detail page):**
> The price right now is $[REF]. In 15 minutes, will Bitcoin be higher or lower? Resolves automatically using Binance BTCUSDT.

**Outcomes:** Higher · Lower

### Resolution criteria (paste verbatim)
> Settled based on the BTCUSDT spot price on Binance at exactly [T+15:00 UTC timestamp]. Reference price was $[REF] at market open ([T timestamp]). If the resolution price is strictly greater than $[REF], "Higher" wins. If strictly less than or equal, "Lower" wins. Source: Binance public API at api.binance.com.

### Edge cases
- **Binance API fails at resolution:** retry 3 times at 10-second intervals. If still failing, fall back to a secondary source (e.g. Coinbase BTC-USD spot) and document the substitution. If both fail, mark market as "needs review" and notify admin.
- **Reference price = resolution price (exact match):** "Lower" wins (market favours one side to avoid 50/50 unresolvable case). Document this in the resolution criteria.
- **Server clock drift:** use NTP sync. Reference and resolution timestamps must come from the same time source.

---

## 2. TER — 12-hour loop

### Schedule
- New market twice daily: **08:00 BTN** and **20:00 BTN**
- Runs every day

### Lifecycle
| Event | Time |
|---|---|
| Market opens | T+0 |
| Reference price stamped | T+0 |
| Betting closes | T+11:55 |
| Resolution price fetched | T+12:00 |
| Market settled | T+12:00 + few seconds |

### Source — pick one before launch

**Option A: ter.bt portal**
- Authoritative, what users see
- Requires scraping if no public API
- Best UX framing for Bhutanese users

**Option B: Solana DEX (Jupiter aggregator)**
- Public API: `https://price.jup.ag/v4/price?ids=[TER_TOKEN_MINT_ADDRESS]`
- Always available, on-chain transparent
- Better for engineering reliability
- TER contract address: starts with `9T6TPrY5Hm...2iVkAzhVUZ` (visible on ter.bt)

**Recommendation:** Use Solana DEX (Jupiter) for resolution but display the price as "TER price" without specifying the source on the market card. Reach out to TER team to confirm which source they'd want cited if asked.

### Currency for reference price
The user's interface should display the price in **INR** (since TER trades against INR primarily and BTN is pegged 1:1).

### Market text (auto-generated)

**Title:**
> TER in 12 hours — Higher or Lower than ₹[REF]?

**Description:**
> TER is currently ₹[REF] per token (each token is 0.01g of vault-backed gold). In 12 hours, will the price be higher or lower? Resolves automatically.

**Outcomes:** Higher · Lower

### Resolution criteria (paste verbatim)
> Settled based on the TER token price in INR at exactly [T+12:00 BTN timestamp], as fetched from [chosen source]. Reference price was ₹[REF] at market open ([T timestamp]). If the resolution price is strictly greater than ₹[REF], "Higher" wins. If strictly less than or equal, "Lower" wins. TER is a sovereign-backed digital gold token issued by GMCA Bhutan and distributed by DK Bank, with each token representing 0.01g of physical gold.

### Edge cases
- **Source unavailable:** retry 3x at 30-second intervals, then fall back to alternate source (the one not picked as primary). If both fail, mark as "needs review."
- **Equal price:** "Lower" wins (same convention as BTC).
- **Significant TER protocol event** (token redesign, vault audit announcement, etc.): admin can pause new market creation but must not modify open markets.

---

## 3. USD/BTN — 24-hour loop (business days only)

### Schedule
- New market once per **Bhutanese business day** at **10:00 BTN**
- Skips weekends and Bhutanese public holidays
- Friday's market resolves at 10:00 next Monday (or next business day after holiday)

### Lifecycle (typical Mon–Thu)
| Event | Time |
|---|---|
| Market opens | T+0 (10:00 day N) |
| Reference rate stamped | T+0 |
| Betting closes | T+23:55 |
| Resolution rate fetched | T+24:00 (10:00 day N+1) |
| Market settled | T+24:00 + few seconds |

### Friday lifecycle
| Event | Time |
|---|---|
| Market opens | Friday 10:00 |
| Betting closes | Monday 09:55 |
| Resolution rate fetched | Monday 10:00 |
| Market settled | Monday 10:00 + few seconds |

### Source
- **URL:** `https://www.rma.org.bt/exchangeRates/`
- **Reference rate:** USD/BTN published rate at market open
- **Resolution rate:** USD/BTN published rate at next business day open

RMA does not appear to expose a public JSON API. Engineer will need to scrape the rate from the page on a schedule. Cache the parsed value with a timestamp.

### Market text (auto-generated)

**Title:**
> USD in 24 hours — Higher or Lower than Nu [REF]?

**Description:**
> The Royal Monetary Authority's published rate today is Nu [REF] per USD. Will tomorrow's rate be higher or lower? Resolves at 10:00 AM next business day using the next official RMA rate.

**Outcomes:** Higher · Lower

### Resolution criteria (paste verbatim)
> Settled based on the USD/BTN reference rate published by the Royal Monetary Authority of Bhutan (RMA) at rma.org.bt/exchangeRates/ on [next business day, 10:00 BTN]. Reference rate was Nu [REF] per USD at market open ([day N, 10:00 BTN]). If the resolution rate is strictly greater than Nu [REF], "Higher" wins. If strictly less than or equal, "Lower" wins.

### Edge cases
- **RMA site is down at scrape time:** retry every 30 minutes for up to 4 hours. If still unavailable, mark as "needs review" and notify admin to resolve manually.
- **Bhutanese public holiday** in middle of week: shift resolution to next business day. Open market description should warn: "Resolves at next published rate, expected [date]."
- **Equal rate:** "Lower" wins.
- **RMA changes URL or page structure:** scraping breaks. Set up monitoring alert on scrape failure.

### Bhutanese public holidays to handle (2026)

The system should have a maintained holiday calendar. Approximate list (verify with NCS):
- January 1 — New Year's Day
- February (varies) — Losar (Bhutanese New Year)
- May 2 — Birth Anniversary of 3rd Druk Gyalpo
- June (varies) — Lord Buddha's Parinirvana
- July (varies) — Birth Anniversary of Guru Rinpoche
- November 11 — Birth Anniversary of 4th Druk Gyalpo
- December 17 — National Day

Mark these dates as `is_business_day = false` in the holiday table.

---

## Common implementation notes

### Single source of truth for time

All three loops share the same timing infrastructure:
- Use NTP-synced server clock
- Store all timestamps in UTC, display in BTN
- Cron jobs run on the server timezone

### Settlement order

When a market resolves:
1. Fetch resolution price from primary source
2. Compare to reference price
3. Determine winning outcome
4. Calculate parimutuel payouts (existing logic)
5. Credit user balances
6. Send Telegram notifications to participants
7. Mark market as `SETTLED`
8. Log full proof: reference price + timestamp, resolution price + timestamp, source URL/API endpoint

### Auto-creation cadence

Use a single cron scheduler that handles all three:

```
*/15 * * * *           → create new BTC market
0 8,20 * * *           → create new TER market
0 10 * * 1-5           → create new USD/BTN market (Mon-Fri only)
```

Each cron job:
1. Fetches reference price
2. Creates market record in DB
3. Schedules resolution job at T+cycle

### Idempotency

If the cron fires twice (network blip, restart), don't create duplicate markets. Use a deterministic market ID based on timestamp:
- BTC: `btc-loop-2026-05-06T14-15-00`
- TER: `ter-loop-2026-05-06T08-00-00`
- USD: `usdbtn-loop-2026-05-06T10-00-00`

### User-facing display

On the feed, show:
- A live countdown to resolution (`Closes in 2:47`)
- The reference price prominently (`vs $98,234`)
- Two big buttons: HIGHER (green) / LOWER (red)
- Pool size and bettor count

When the market resolves, push a Telegram notification to all participants:
> Bitcoin closed at $98,401. Higher won! You won Nu X. Tap to view.

### Notification rate limits

If 96 BTC markets resolve per day, you'll generate up to 96 Telegram notifications per active user per day. That's too many.

**Recommendation:** batch notifications. Send one summary notification every 4 hours instead of per-market. Users can opt in to per-market notifications if they want.

---

## What's NOT in scope (manually built)

These markets are created by admin per event:

- **Cricket / IPL match winners** — admin opens the night before each match
- **Bhutan football matches** — admin opens when fixture announced
- **International football** (UCL, World Cup) — admin opens when fixture announced
- **Anchor markets** (IPL Champion, UCL Winner, World Cup Winner) — admin opens once, runs for weeks

These follow the existing manual market creation flow. No automation needed.

---

## Launch checklist

Before turning on the loops:

- [ ] Binance API integration tested with 100 sequential price fetches
- [ ] TER source confirmed (portal vs Solana DEX) and tested
- [ ] RMA rate scraping tested across a full week, confirmed no 404 / format changes
- [ ] Bhutanese holiday calendar populated for next 12 months
- [ ] Cron jobs configured with idempotency
- [ ] Notification batching enabled (not 96 BTC pings/day)
- [ ] Failure modes tested (mock each source going down)
- [ ] First 10 markets per loop run as dry-run before going live with real money
- [ ] Admin panel has a kill switch for each loop independently

---

## Questions for engineer

1. Does the existing market creation API support programmatic open/close/resolve, or does it need extension?
2. Where do we want to centralize the price-fetch service? New microservice or part of the existing backend?
3. How do we handle a 96-markets-per-day load on the parimutuel engine? Existing logic was designed for human-paced market creation.
4. Do existing user notification preferences support batching, or does that need to be added?

---

Reach out to Gelay with any questions before starting implementation.
