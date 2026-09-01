# Dispute Resolution — Bonded Two-Sided Contest, Admin Final Call

## What We Chose

**Admin proposes, anyone with a position can contest it by locking a bond, admin makes the final call.**

When a market closes, the admin proposes a winning outcome and an objection window opens (10, 20, 30, 60 or 120 minutes). Bettors may then take a side, each locking an equal bond:

- **OBJECT** — the proposed outcome is wrong
- **SUPPORT** — the proposed outcome is right, and defends it

If nobody objects, the market auto-settles on the proposal with no further admin action. If anyone objects, the market freezes until a human admin resolves it. The side that turns out to be right gets its bonds back **plus** the losing side's forfeited bonds.

## Flow

```
CLOSED → RESOLVING (admin proposes outcome, window opens)
         ↓
         First objector locks a bond and sets the per-head amount
         Later participants match it exactly, on either side
         ↓
         no objections → auto-settle on the proposal (cron)
         objections     → admin reviews and makes the final call
         ↓
RESOLVING → RESOLVED → SETTLED
         (winning side's bonds returned + rewarded; losing side forfeits)
```

## The Money

**Bonds are real stakes, not deposits.** The losing side forfeits. This is deliberate: a bond that is always refunded costs nothing to post, and an objection that costs nothing is not a signal.

**The first objector sets the bond.** Any amount at or above their book's floor. Everyone who joins afterwards — objecting or defending — must match it exactly, so all stakes in one contest are equal and the split is a clean pro-rata.

**Floors are per currency**, and are chosen numbers rather than conversions (there is no exchange rate anywhere in this system):

| Book | Floor | Override |
|---|---|---|
| BTN | Nu 10 | `BTN_MIN_DISPUTE_BOND` |
| USDT | 0.5 USDT | `USDT_MIN_DISPUTE_BOND` |

**When the admin is overturned but nobody defended**, the correct objectors would win an empty forfeit pool. They are instead rewarded from that book's house cut — `CHALLENGER_REWARD_HOUSE_CUT_FRACTION` (default 0.2, i.e. 20% of the cut ≈ 2% of the pool at a 10% edge), split pro-rata by bond and capped at the real house residual so the pool still balances exactly.

**Forfeited money with no winning side**, plus floor-rounding dust, is booked as that book's house revenue and flows through the normal revenue-distribution path rather than sitting off-ledger.

**A cancelled market returns every locked bond at face value.** There is no contest to win once the market is void, so nobody forfeits and nobody is rewarded.

## One Contest Per Book

The **verdict** is market-wide: there is one outcome and one fact to be right about, one window, and one admin decision. An objection raised in any book freezes the whole market for review, and every book's payouts wait for that decision.

The **money** is per book. You bond in your own account's currency, against defenders in that same currency, and are paid from their forfeited bonds. A ngultrum forfeit can never fund a USDT reward.

This is not a nicety. Pooling bonds across books would require an exchange rate, and deliberately none exists in this system — inventing one for a forfeit split would be inventing one for real money. The per-head bond and the forfeited pool therefore live on `market_books` alongside `houseEdgePct` and `minStake`, and `disputes.currency` records which book each entry belongs to.

Practical consequences:

- You need an active position **in the book you are bonding into**. A ngultrum stake is not exposure to the USDT pool's payout.
- Each book has its own first objector and its own agreed bond. A Nu 500 BTN contest does not oblige a USDT bettor to find Nu 500.
- Bond totals in admin reporting are broken out per currency (`bondsByCurrency`). Any single cross-currency total would be meaningless.

## Why Not a Fully Decentralised Oracle

Polymarket uses UMA — token holders vote on disputed outcomes. That needs an on-chain governance token, economic incentives for voters, contracts for bond escrow and voting, and a community large enough to resist capture. We have none of those yet, and building a trustless oracle before there is volume would be expensive to maintain and no fairer in practice.

What we have taken from that design is the part that works without a chain: **an optimistic proposal, a challenge window, and bonds with real consequences on both sides.** The admin is the final oracle; the bonds and the audit trail are what keep that honest.

## Why This Is Still Fair

**1. Full audit trail.** Every bond, admin action and settlement is a ledger row with a timestamp and a currency. The public Resolution Log shows every settled market with its proposal, its final outcome, whether those differed, the objection count, and the admin's evidence.

**2. Bonds cut both ways.** An objector who is wrong loses their bond; a defender who is wrong loses theirs. Neither side is free.

**3. Admin accountability is public and automatic.** An overturned proposal increments that admin's wrong-resolution count and posts a public Telegram alert with their running accuracy record. There is no quiet correction.

**4. Zero-objection markets cannot be rushed.** An admin may not force-resolve early while the window is open unless objections already exist — meaning they have something to review. Otherwise the cron settles it when the window expires.

## Known Gaps

| Gap | Status |
|---|---|
| No deadline on the admin's final call | A contested market stays `RESOLVING` indefinitely if nobody acts. Payouts and bonds stay frozen. Needs an escalation path. |
| Community vote round | Deferred — needs a larger active user base |
| On-chain bond escrow | Deferred — needs the governance layer above |

## Future Upgrade Path

1. Bound the admin's decision window, with an escalation when it lapses
2. Add a community vote round between the objection threshold and the admin override
3. Move bond escrow on-chain for markets with verifiable outcomes

For now, the admin is the oracle. The bonds and the audit trail are the accountability.
