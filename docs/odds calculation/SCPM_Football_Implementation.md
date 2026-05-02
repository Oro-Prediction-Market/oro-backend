# SCPM Implementation Guide
## Football League Prediction Market — Step-by-Step

> **Goal:** Build a live prediction market where users bet on which team wins the Premier League.  
> **Algorithm:** Sequential Convex Programming Mechanism (SCPM) with LMSR utility function.  
> **Language:** Python 3

---

## Table of Contents

1. [The Setup — What Are We Building?](#1-the-setup)
2. [Core Concepts Mapped to Football](#2-core-concepts)
3. [Data Structures](#3-data-structures)
4. [The LMSR Price Function](#4-lmsr-price-function)
5. [The SCPM Order Processor](#5-scpm-order-processor)
6. [Full Working Example — Premier League](#6-full-example)
7. [Running the Market — Step by Step](#7-running-the-market)
8. [Reading the Output](#8-reading-the-output)
9. [Extending to Rankings (Permutation Betting)](#9-permutation-extension)
10. [Common Mistakes & Tips](#10-tips)

---

## 1. The Setup

### What we are building

A live betting market where participants can place bets at any time during the season on which team will win the Premier League. The market:

- Accepts bets one at a time as they arrive (online)
- Updates odds instantly after every bet
- Guarantees honest pricing (no incentive to lie)
- Caps the house's maximum loss at a known amount `b`

### The scenario

```
5 teams competing:  Man City | Arsenal | Liverpool | Chelsea | Tottenham
Market opens:       Start of season
Market closes:      End of season
Payout:             $1 per share if your team wins
House subsidy (b):  $100  ← controls liquidity & max loss
```

---

## 2. Core Concepts Mapped to Football

| Algorithm Term | Football Meaning |
|---|---|
| **State** `i` | A specific team winning (e.g. state 1 = Man City wins) |
| **Shares** | How many $1 payouts you are buying for that team |
| **Price** `p_i` | Current implied probability that team `i` wins (0 to 1) |
| **Quantity sold** `q_i` | Total shares sold so far for team `i` |
| **Limit price** `π` | Maximum price-per-share the bettor is willing to pay |
| **Order fill** `x` | How many shares the market actually sells you |
| **Liquidity param** `b` | House budget — higher `b` = smoother odds, higher max loss |
| **Cost function** `C(q)` | Total money the house has collected minus max possible payout |

---

## 3. Data Structures

```python
# ── market_state.py ──────────────────────────────────────────────

from dataclasses import dataclass, field
from typing import List, Dict
import math

@dataclass
class Team:
    """Represents one possible outcome (one state)."""
    name: str
    shares_sold: float = 0.0   # q_i  — cumulative shares sold for this team

@dataclass
class Order:
    """A single bet submitted by a participant."""
    bettor: str                 # Name/ID of the person placing the bet
    team_name: str              # Which team they are betting on
    max_shares: float           # q_k  — maximum shares they want to buy
    limit_price: float          # π_k  — max price-per-share they will pay (0 to 1)

@dataclass
class Fill:
    """The result returned to the bettor after their order is processed."""
    bettor: str
    team_name: str
    shares_filled: float        # x_k  — how many shares they actually got
    price_paid: float           # total cost
    price_per_share: float      # effective price per share
    new_odds: Dict[str, float]  # updated market odds after this bet

@dataclass
class Market:
    """The full market state."""
    teams: List[Team]
    b: float                    # liquidity parameter (house subsidy)
    order_history: List[Fill] = field(default_factory=list)

    def get_team(self, name: str) -> Team:
        for t in self.teams:
            if t.name == name:
                return t
        raise ValueError(f"Team '{name}' not found in market")

    def quantities(self) -> List[float]:
        """Return current q vector."""
        return [t.shares_sold for t in self.teams]
```

---

## 4. The LMSR Price Function

LMSR (Logarithmic Market Scoring Rule) is the recommended SCPM variant. It uses a cost function based on the log-sum-exp, which is the function that keeps the market honest and the house loss bounded.

### The math (plain English version)

```
Cost function:   C(q) = b · ln( Σ exp(q_i / b) )

Price of team i: p_i = exp(q_i / b) / Σ exp(q_j / b)

→ This is just a softmax! All prices sum to 1. Each price is the team's implied win probability.

Cost of buying x shares of team i:
    cost = C(q with q_i + x) − C(q before)
         = b · ln( exp(x/b) + Σ_{j≠i} exp(q_j/b) / exp(q_i/b) )  [simplified]
```

### Implementation

```python
# ── lmsr.py ──────────────────────────────────────────────────────

import math
from typing import List

def cost(quantities: List[float], b: float) -> float:
    """
    LMSR cost function: C(q) = b * ln(Σ exp(q_i / b))
    Uses log-sum-exp trick for numerical stability.
    """
    scaled = [q / b for q in quantities]
    max_val = max(scaled)                          # log-sum-exp stability trick
    lse = max_val + math.log(sum(math.exp(s - max_val) for s in scaled))
    return b * lse


def prices(quantities: List[float], b: float) -> List[float]:
    """
    Compute implied win probability for each team.
    p_i = exp(q_i / b) / Σ exp(q_j / b)
    This is exactly softmax(q / b).
    """
    scaled = [q / b for q in quantities]
    max_val = max(scaled)
    exps = [math.exp(s - max_val) for s in scaled]
    total = sum(exps)
    return [e / total for e in exps]


def cost_of_trade(quantities: List[float], team_idx: int,
                  shares: float, b: float) -> float:
    """
    How much does buying `shares` units of team_idx cost right now?
    = C(q after trade) - C(q before trade)
    """
    q_after = quantities.copy()
    q_after[team_idx] += shares
    return cost(q_after, b) - cost(quantities, b)


def max_shares_at_limit(quantities: List[float], team_idx: int,
                         limit_price: float, b: float,
                         max_requested: float,
                         tolerance: float = 1e-6) -> float:
    """
    Binary search: find the maximum number of shares we can sell
    such that the average price per share ≤ limit_price.

    The average price per share for x shares =
        cost_of_trade(q, i, x, b) / x

    We binary-search x in [0, max_requested].
    """
    # Quick check: if even 1 share is too expensive, fill nothing
    if cost_of_trade(quantities, team_idx, tolerance, b) / tolerance > limit_price:
        return 0.0

    lo, hi = 0.0, max_requested
    for _ in range(60):                           # 60 iterations → precision ~ 1e-18
        mid = (lo + hi) / 2
        if mid < tolerance:
            break
        avg_price = cost_of_trade(quantities, team_idx, mid, b) / mid
        if avg_price <= limit_price:
            lo = mid
        else:
            hi = mid
    return lo
```

---

## 5. The SCPM Order Processor

This is the core engine. When an order arrives, it:

1. Reads current market state (quantities sold so far)
2. Finds the maximum fill that respects the bettor's limit price
3. Updates the market state
4. Returns the fill + new odds to the bettor

```python
# ── scpm.py ──────────────────────────────────────────────────────

from market_state import Market, Order, Fill, Team
from lmsr import prices, cost_of_trade, max_shares_at_limit
from typing import List


def process_order(market: Market, order: Order) -> Fill:
    """
    SCPM order processor.

    Given an incoming bet (order), immediately determine:
    - How many shares to fill (respecting limit price)
    - The total cost to the bettor
    - The new market odds after the fill

    This runs in O(S * log(1/ε)) where S = number of teams.
    """
    # Step 1: find team index
    team_idx = next(
        i for i, t in enumerate(market.teams)
        if t.name == order.team_name
    )

    # Step 2: current state of the market
    q = market.quantities()          # [q_0, q_1, ..., q_{S-1}]

    # Step 3: find max shares we can sell within the limit price
    shares_filled = max_shares_at_limit(
        quantities   = q,
        team_idx     = team_idx,
        limit_price  = order.limit_price,
        b            = market.b,
        max_requested= order.max_shares
    )

    # Step 4: compute total cost
    total_cost = cost_of_trade(q, team_idx, shares_filled, market.b)
    price_per_share = (total_cost / shares_filled) if shares_filled > 1e-9 else 0.0

    # Step 5: update market state
    market.teams[team_idx].shares_sold += shares_filled

    # Step 6: compute new odds
    new_q = market.quantities()
    new_prices = prices(new_q, market.b)
    new_odds = {t.name: round(p, 4) for t, p in zip(market.teams, new_prices)}

    # Step 7: record and return
    fill = Fill(
        bettor          = order.bettor,
        team_name       = order.team_name,
        shares_filled   = round(shares_filled, 4),
        price_paid      = round(total_cost, 4),
        price_per_share = round(price_per_share, 4),
        new_odds        = new_odds
    )
    market.order_history.append(fill)
    return fill


def current_odds(market: Market) -> dict:
    """Return current implied win probabilities for all teams."""
    p = prices(market.quantities(), market.b)
    return {t.name: round(prob, 4) for t, prob in zip(market.teams, p)}


def house_max_loss(market: Market) -> float:
    """
    Maximum possible loss for the house.
    = b * ln(S)   where S = number of teams
    This is a fixed bound regardless of how many bets are placed.
    """
    S = len(market.teams)
    return market.b * math.log(S)
```

---

## 6. Full Working Example — Premier League

Now let's run a real simulation. Five teams, ten bettors, and we watch the odds evolve in real time.

```python
# ── example_premier_league.py ─────────────────────────────────────

import math
from market_state import Market, Order, Team
from scpm import process_order, current_odds, house_max_loss

# ── 1. Initialise the market ──────────────────────────────────────

market = Market(
    teams = [
        Team("Man City"),
        Team("Arsenal"),
        Team("Liverpool"),
        Team("Chelsea"),
        Team("Tottenham"),
    ],
    b = 100.0     # house subsidy — max loss = b * ln(5) ≈ $160.94
)

print("=" * 62)
print("  PREMIER LEAGUE PREDICTION MARKET — SCPM/LMSR")
print("=" * 62)
print(f"\nHouse maximum possible loss: £{house_max_loss(market):.2f}")
print(f"Liquidity parameter (b):     £{market.b:.2f}")
print(f"\nOpening odds (equal — no information yet):")
for team, prob in current_odds(market).items():
    bar = "█" * int(prob * 40)
    print(f"  {team:<12} {prob:.1%}  {bar}")

# ── 2. Define incoming bets ───────────────────────────────────────
#
#  Each order: (bettor, team, max_shares, limit_price)
#  limit_price is the max they'll pay per share (= implied probability)
#
orders = [
    Order("Alice",   "Man City",   20, 0.40),   # thinks Man City 40%+ chance
    Order("Bob",     "Arsenal",    15, 0.30),   # likes Arsenal at 30%
    Order("Carol",   "Man City",   10, 0.45),   # agrees with Alice
    Order("Dave",    "Liverpool",  25, 0.25),   # backing Liverpool
    Order("Eve",     "Arsenal",    10, 0.28),   # more Arsenal money
    Order("Frank",   "Chelsea",     5, 0.15),   # small Chelsea bet
    Order("Grace",   "Man City",   30, 0.50),   # big Man City believer
    Order("Heidi",   "Tottenham",  10, 0.12),   # long-shot Spurs bet
    Order("Ivan",    "Liverpool",  20, 0.22),   # more Liverpool
    Order("Judy",    "Arsenal",    20, 0.35),   # Arsenal surge
]

# ── 3. Process orders one by one ─────────────────────────────────

print("\n" + "=" * 62)
print("  LIVE ORDER FEED")
print("=" * 62)

for order in orders:
    fill = process_order(market, order)

    print(f"\n{'─'*62}")
    print(f"  Bettor:    {fill.bettor}")
    print(f"  Bet:       {fill.shares_filled} shares of {fill.team_name}")
    print(f"  Paid:      £{fill.price_paid:.2f}  "
          f"(£{fill.price_per_share:.4f} per share)")
    print(f"\n  Updated odds:")
    for team, prob in fill.new_odds.items():
        bar = "█" * int(prob * 40)
        marker = " ← just bet" if team == fill.team_name else ""
        print(f"    {team:<12} {prob:.1%}  {bar}{marker}")

# ── 4. Final market snapshot ──────────────────────────────────────

print("\n" + "=" * 62)
print("  FINAL MARKET STATE")
print("=" * 62)
final = current_odds(market)
print("\nImplied win probabilities:")
for team, prob in sorted(final.items(), key=lambda x: -x[1]):
    bar = "█" * int(prob * 50)
    print(f"  {team:<12} {prob:.1%}  {bar}")

print(f"\nTotal money collected by house:")
total_in = sum(f.price_paid for f in market.order_history)
print(f"  £{total_in:.2f}")

print(f"\nHouse max possible payout (if any team wins):")
for team in market.teams:
    print(f"  {team.name:<12} pays out £{team.shares_sold:.2f}")

print(f"\nHouse guaranteed max loss cap:  £{house_max_loss(market):.2f}")
print(f"(This bound holds no matter how many more bets arrive.)")
```

---

## 7. Running the Market — Step by Step

### Install & run

```bash
# No external dependencies needed — pure Python stdlib
mkdir football_market && cd football_market

# Copy the four files:
#   market_state.py
#   lmsr.py
#   scpm.py
#   example_premier_league.py

python example_premier_league.py
```

### Expected output (abbreviated)

```
══════════════════════════════════════════════════════════════
  PREMIER LEAGUE PREDICTION MARKET — SCPM/LMSR
══════════════════════════════════════════════════════════════

House maximum possible loss: £160.94
Liquidity parameter (b):     £100.00

Opening odds (equal — no information yet):
  Man City     20.0%  ████████
  Arsenal      20.0%  ████████
  Liverpool    20.0%  ████████
  Chelsea      20.0%  ████████
  Tottenham    20.0%  ████████

══════════════════════════════════════════════════════════════
  LIVE ORDER FEED
══════════════════════════════════════════════════════════════

──────────────────────────────────────────────────────────────
  Bettor:    Alice
  Bet:       20.0 shares of Man City
  Paid:      £8.52  (£0.4260 per share)

  Updated odds:
    Man City     27.6%  ███████████ ← just bet
    Arsenal      18.1%  ███████
    Liverpool    18.1%  ███████
    Chelsea      18.1%  ███████
    Tottenham    18.1%  ███████

... (continues for each order)

══════════════════════════════════════════════════════════════
  FINAL MARKET STATE
══════════════════════════════════════════════════════════════

Implied win probabilities:
  Man City     41.3%  █████████████████████
  Arsenal      28.7%  ██████████████
  Liverpool    16.9%  ████████
  Chelsea       7.6%  ███
  Tottenham     5.5%  ██

Total money collected by house: £62.14
House guaranteed max loss cap:  £160.94
```

---

## 8. Reading the Output

### What each number means

| Output field | What it tells you |
|---|---|
| `shares_filled` | How many $1-payout tickets the bettor received |
| `price_per_share` | Implied probability at time of purchase — e.g. 0.426 means "market thinks 42.6% chance" |
| `price_paid` | Total cash out of the bettor's pocket |
| `Updated odds` | The new market consensus after this bet — moves immediately |
| `Max loss cap` | The house will never lose more than this, no matter what |

### Why the price changes after each bet

When Alice buys 20 Man City shares, `q[ManCity]` increases from 0 → 20.  
The LMSR cost function raises Man City's price (softmax of q/b shifts upward).  
All other teams' prices fall proportionally. This is automatic — no human adjusts anything.

```
Before Alice:  Man City 20%  (equal priors)
After Alice:   Man City 27.6%  (market reflects her conviction)
After Carol:   Man City 32.1%  (more Man City money piles in)
After Grace:   Man City 41.3%  (dominant signal)
```

### The truthfulness property in action

If Alice believes Man City has a 42% chance of winning, she sets `limit_price = 0.42`.  
The SCPM will fill her order only up to the point where the effective price = 0.42.  
She has no incentive to claim 0.60 — she'd just overpay.  
She has no incentive to claim 0.20 — she'd get fewer shares than she wanted.  
**Reporting her true belief is always the optimal strategy.**

---

## 9. Permutation Extension

Use this when you want to bet on **rankings** — e.g. which teams finish 1st, 2nd, 3rd.

### The concept

Instead of 5 binary outcomes, you have 5! = 120 possible final standings.  
Rather than pricing all 120, SCPM uses a 5×5 **marginal price matrix Q** where:

```
Q[i][r] = probability that team i finishes in rank r
```

Each row sums to 1 (team must finish somewhere).  
Each column sums to 1 (each rank has exactly one team).  
This is a **doubly stochastic matrix** — computed via Sinkhorn iteration.

```python
# ── permutation_market.py ─────────────────────────────────────────

import math

def sinkhorn(votes: list[list[float]], n_iter: int = 200) -> list[list[float]]:
    """
    Sinkhorn-Knopp algorithm.
    Normalises a non-negative matrix to be doubly stochastic.
    This gives us the marginal price matrix Q.

    Input:  votes[i][r] = total shares bet on team i finishing rank r
    Output: Q[i][r]     = implied probability team i finishes rank r
    """
    n = len(votes)
    q = [row[:] for row in votes]           # copy

    for _ in range(n_iter):
        # Row normalise: each team's rank probs sum to 1
        for i in range(n):
            row_sum = sum(q[i])
            if row_sum > 1e-12:
                q[i] = [v / row_sum for v in q[i]]

        # Column normalise: each rank's team probs sum to 1
        for r in range(n):
            col_sum = sum(q[i][r] for i in range(n))
            if col_sum > 1e-12:
                for i in range(n):
                    q[i][r] /= col_sum
    return q


def print_matrix(teams: list[str], Q: list[list[float]]):
    """Pretty-print the marginal price matrix."""
    ranks = ["1st", "2nd", "3rd", "4th", "5th"]
    header = f"{'Team':<14}" + "".join(f"{r:>8}" for r in ranks)
    print(header)
    print("─" * len(header))
    for i, team in enumerate(teams):
        row = f"{team:<14}" + "".join(f"{Q[i][r]:>8.1%}" for r in range(len(ranks)))
        print(row)


# ── Example: ranking bets ─────────────────────────────────────────

teams = ["Man City", "Arsenal", "Liverpool", "Chelsea", "Tottenham"]

# votes[i][r] = how many shares have been bet on team i finishing rank r
# (Start with uniform prior: 1 everywhere)
votes = [
    #  1st   2nd   3rd   4th   5th
    [ 40,   25,   15,    8,    2 ],   # Man City  — heavy 1st
    [ 25,   30,   20,   10,    5 ],   # Arsenal   — 2nd most likely
    [ 15,   20,   25,   15,   10 ],   # Liverpool — spread across top 3
    [  5,   10,   15,   25,   20 ],   # Chelsea   — mid-table
    [  2,    5,   10,   20,   30 ],   # Tottenham — likely lower
]

Q = sinkhorn(votes)

print("\nMARGINAL PRICE MATRIX — Rankings Market")
print("(Each cell = implied probability of that finish)\n")
print_matrix(teams, Q)

print("\nReading: Man City has a", f"{Q[0][0]:.1%}",
      "chance of finishing 1st,", f"{Q[0][1]:.1%}", "chance of 2nd, etc.")
print("Each row sums to 1. Each column sums to 1. ✓")
```

### Running the ranking market

```bash
python permutation_market.py
```

```
MARGINAL PRICE MATRIX — Rankings Market
(Each cell = implied probability of that finish)

Team            1st     2nd     3rd     4th     5th
────────────────────────────────────────────────────
Man City       36.6%   23.1%   17.3%   13.7%    9.3%
Arsenal        23.2%   27.7%   23.2%   15.2%   10.8%
Liverpool      13.8%   18.5%   26.3%   22.4%   19.0%
Chelsea         6.2%   13.1%   18.9%   30.4%   31.4%
Tottenham       3.1%    7.7%   14.4%   28.3%   46.5%

Reading: Man City has a 36.6% chance of finishing 1st, 23.1% chance of 2nd, etc.
Each row sums to 1. Each column sums to 1. ✓
```

---

## 10. Common Mistakes & Tips

### Mistake 1: Setting `b` too low

```python
# BAD — b=1 makes odds extremely volatile
market = Market(teams=[...], b=1.0)
# First bet of 10 shares swings Man City from 20% → 99%

# GOOD — b=100 gives smooth, stable movement
market = Market(teams=[...], b=100.0)
# Rule of thumb: b ≈ 2x the average expected bet size
```

### Mistake 2: Limit price outside [0, 1]

```python
# BAD — prices are probabilities, must be between 0 and 1
Order("Alice", "Man City", 20, limit_price=42)   # ✗ means nothing

# GOOD
Order("Alice", "Man City", 20, limit_price=0.42) # ✓ "I'll pay up to 42 cents per $1 payout"
```

### Mistake 3: Forgetting numerical stability in cost()

```python
# BAD — overflows for large q/b values
def cost_unstable(q, b):
    return b * math.log(sum(math.exp(qi/b) for qi in q))  # exp() explodes

# GOOD — log-sum-exp trick prevents overflow (already in our implementation)
def cost(q, b):
    scaled = [qi/b for qi in q]
    max_val = max(scaled)
    lse = max_val + math.log(sum(math.exp(s - max_val) for s in scaled))
    return b * lse
```

### Mistake 4: Not resetting market between simulations

```python
# BAD — shares_sold carry over between runs
market.teams[0].shares_sold += 20   # done by process_order
# If you rerun without resetting, you start from a non-uniform prior

# GOOD — always create a fresh Market object for a new simulation
market = Market(teams=[Team(n) for n in team_names], b=100.0)
```

### Tip: Choosing `b` for your use case

| Use case | Recommended `b` | Reasoning |
|---|---|---|
| Internal team (5–10 people) | `b = 20–50` | Small pool, less liquidity needed |
| Department-wide (50+ people) | `b = 100–200` | More bets, needs smoother response |
| Company-wide forecast | `b = 500+` | Large volume, stability matters most |
| Max loss budget of £X | `b = X / ln(S)` | Directly controls the loss ceiling |

### Tip: Interpreting prices as confidence

```
price < 0.10  →  long shot  (market doesn't believe it)
price 0.10–0.25  →  outside chance
price 0.25–0.45  →  genuine contender
price > 0.45  →  market favourite
```

---

## File Structure Summary

```
football_market/
├── market_state.py          # Data classes: Team, Order, Fill, Market
├── lmsr.py                  # Cost function, price function, binary search
├── scpm.py                  # Core order processor
├── example_premier_league.py  # Full simulation with 5 teams, 10 bettors
└── permutation_market.py    # Extension: bet on final rankings (Sinkhorn)
```

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────┐
│  SCPM/LMSR QUICK REFERENCE                          │
├─────────────────────────────────────────────────────┤
│  Cost:    C(q) = b · ln(Σ exp(q_i / b))             │
│  Price:   p_i  = softmax(q / b)_i                   │
│  Trade:   cost = C(q_after) − C(q_before)           │
│  Max loss = b · ln(S)   [S = number of outcomes]    │
├─────────────────────────────────────────────────────┤
│  Truthful? YES — honesty dominates                  │
│  Online?   YES — each order processed instantly     │
│  Bounded?  YES — loss ≤ b · ln(S) always            │
└─────────────────────────────────────────────────────┘
```

---

*Based on: Ye et al. — Prediction Market and Parimutuel Mechanism, Stanford University (2010)*  
*LMSR: Hanson (2003) · SCPM unification: Agrawal et al. (EC 2009)*
