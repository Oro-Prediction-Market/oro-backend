# LMSR in Oro: Bhutanese Archery Betting Platform

> **Project-Specific Guide**: This document explains how Logarithmic Market Scoring Rule (LMSR) relates to Oro's current parimutuel implementation and how it could be integrated for improved odds display.

## Table of Contents

1. [Oro's Current Implementation](#Oros-current-implementation)
2. [LMSR Conceptual Overview](#lmsr-conceptual-overview)
3. [Core Formula](#core-formula)
4. [Price Calculation](#price-calculation)
5. [Worked Example: Archery Match](#worked-example-archery-match)
6. [Integrating LMSR with Oro's Parimutuel System](#integrating-lmsr-with-Oros-parimutuel-system)
7. [Implementation Guide for Oro](#implementation-guide-for-Oro)
8. [Liquidity Parameter b](#liquidity-parameter-b)
9. [Edge Cases & Considerations](#edge-cases--considerations)

---

## Oro's Current Implementation

### Existing Parimutuel Engine

**File**: `/backend/src/markets/parimutuel.engine.ts`

Oro currently uses a **traditional parimutuel** system:

```typescript
// Current odds calculation in ParimutuelEngine
calcOdds(totalPool: number, houseEdgePct: number, outcomePool: number): number {
  if (outcomePool === 0) return 0;
  const payoutPool = totalPool * (1 - houseEdgePct / 100);
  return payoutPool / outcomePool;
}
```

**How it works:**

1. Bets accumulate in pools per outcome (`outcome.totalBetAmount`)
2. Total pool grows as bets are placed (`market.totalPool`)
3. Odds = `(total pool × (1 - house edge)) / outcome pool`
4. Final payout: Each winner gets their proportional share of the payout pool

### Data Model

**Entities** (from `/backend/src/entities/`):

```typescript
// Market entity
class Market {
  totalPool: number; // Sum of all bets
  houseEdgePct: number; // Default: 5%
  status: MarketStatus; // upcoming|open|closed|resolved|settled
  outcomes: Outcome[]; // Array of betting options
}

// Outcome entity
class Outcome {
  label: string; // e.g., "Thimphu Tigers"
  totalBetAmount: number; // Pool for this outcome
  currentOdds: number; // Calculated odds
  isWinner: boolean; // Set during resolution
}

// Bet entity
class Bet {
  amount: number; // Bet amount in BTN/TON/credits
  oddsAtPlacement: number; // Snapshot of odds
  status: BetStatus; // pending|won|lost|refunded
  payout: number; // Calculated after settlement
}
```

### Payment Methods

**From**: `/frontend/src/config.ts`

```typescript
payments: {
  dkBank: {
    currency: "BTN",      // Bhutanese Ngultrum
    minBet: 50,           // 50 BTN minimum (~$0.60 USD)
  },
  ton: {
    currency: "TON",
    minBet: 0.5,          // 0.5 TON minimum
  },
  credits: {
    starterBalance: 1000, // Virtual credits for testing
  }
}
```

### Current User Flow

1. **Browse Markets** → `/frontend/src/tma/pages/MarketsPage.tsx`
2. **Select Market** → `/frontend/src/tma/pages/MarketDetailPage.tsx`
3. **Choose Payment** → DK Bank, TON, or Credits
4. **Place Bet** → `/frontend/src/tma/pages/DKBankBetPage.tsx`
5. **View Odds** → Parimutuel odds update in real-time

---

## LMSR Conceptual Overview

### What is LMSR?

The **Logarithmic Market Scoring Rule (LMSR)** is an automated market maker (AMM) mechanism designed for prediction markets. It was developed by **Robin Hanson** in 2002 as a way to provide continuous liquidity and instant pricing for prediction market outcomes.

### Key Characteristics

- **Automated Market Maker**: No need for matching buyers and sellers; the market itself acts as the counterparty
- **Always Liquid**: Traders can always buy or sell shares at any time
- **Proper Scoring Rule**: Incentivizes truthful probability reporting
- **Bounded Loss**: The market maker's maximum loss is predetermined and bounded
- **Smooth Price Discovery**: Prices adjust gradually based on trading activity

### Origins

Robin Hanson introduced LMSR in his 2003 paper _"Combinatorial Information Market Design"_ and later refined it in _"Logarithmic Market Scoring Rules for Modular Combinatorial Information Aggregation"_ (2007). The mechanism was designed to solve the liquidity problem in prediction markets while maintaining proper incentives for information revelation.

### Why Use LMSR?

1. **Guaranteed Liquidity**: Unlike order book markets, LMSR always has liquidity
2. **Bounded Risk**: The market operator knows their maximum potential loss upfront
3. **Price Elasticity**: Prices adjust smoothly based on bet size and current state
4. **Information Aggregation**: Effectively aggregates dispersed information through trading
5. **Simple to Implement**: Requires only tracking outstanding shares per outcome

---

## Core Formula

### The Cost Function

The fundamental equation of LMSR is the **cost function** C(q), which determines the cost to move the market from one state to another:

```
C(q) = b · ln(Σᵢ exp(qᵢ / b))
```

Where:

- **C(q)**: Total cost to purchase shares to reach state q
- **q = (q₁, q₂, ..., qₙ)**: Vector representing outstanding shares for each outcome
- **qᵢ**: Number of outstanding shares for outcome i
- **b**: Liquidity parameter (measured in currency units)
- **n**: Number of possible outcomes
- **ln**: Natural logarithm (base e)
- **exp**: Exponential function (eˣ)

### Variable Breakdown

| Variable | Meaning                          | Example Value                |
| -------- | -------------------------------- | ---------------------------- |
| **b**    | Liquidity depth/subsidy          | 100 (BTN, USD, etc.)         |
| **qᵢ**   | Outstanding shares for outcome i | q₁ = 50, q₂ = 30             |
| **n**    | Number of outcomes               | 2, 3, or more                |
| **C(q)** | Cost to reach state q            | Calculated value in currency |

### Intuition

The cost function has an interesting property:

- When **qᵢ increases** (more shares bought), the exponential term **exp(qᵢ/b)** grows larger
- The logarithm "dampens" this growth, creating smooth price curves
- The parameter **b** controls how quickly prices respond to trading

---

## Price Calculation

### Deriving Current Prices

The **instantaneous price** (probability) of outcome i is the partial derivative of the cost function:

```
pᵢ = ∂C/∂qᵢ = exp(qᵢ / b) / Σⱼ exp(qⱼ / b)
```

This can also be written using the **softmax function**:

```
pᵢ = softmax(qᵢ / b) = exp(qᵢ / b) / Σⱼ exp(qⱼ / b)
```

### Key Properties

1. **Sum to 1**: Σᵢ pᵢ = 1 (probabilities are normalized)
2. **Range [0,1]**: Each 0 ≤ pᵢ ≤ 1
3. **Monotonic**: As qᵢ increases, pᵢ increases
4. **Continuous**: Prices change smoothly

### Computing Cost of a Trade

To buy **Δqᵢ** shares of outcome i:

```
Cost = C(q + Δq) - C(q)

where Δq = (0, ..., Δqᵢ, ..., 0)
```

**Example:**

```
Before: q = (50, 30)
After:  q' = (60, 30)  [bought 10 shares of outcome 1]

Cost = C(60, 30) - C(50, 30)
```

---

## Worked Example: Archery Match

### Scenario: Thimphu Tigers vs Paro Panthers

This example uses Oro's actual configuration and entity structure.

**Setup:**

- **Market**: National Championship Final
- **Outcomes**:
  - Outcome 1: "Thimphu Tigers"
  - Outcome 2: "Paro Panthers"
- **Currency**: BTN (Bhutanese Ngultrum)
- **House Edge**: 5% (from `config.markets.defaultHouseEdge`)
- **Liquidity Parameter**: b = 1000 BTN
- **Initial State**: No bets placed yet

### Oro's Current Parimutuel vs LMSR

| Aspect              | Oro's Parimutuel | LMSR Alternative       |
| ------------------- | ----------------- | ---------------------- |
| **Initial odds**    | Undefined (0/0)   | 50/50 (balanced start) |
| **After first bet** | Extreme odds      | Smooth adjustment      |
| **Price discovery** | Stepwise jumps    | Continuous curve       |
| **Early betting**   | High risk         | Better price stability |

### Step 1: Initial State (LMSR)

**Outstanding shares:**

```
q = (0, 0)
```

**Initial cost:**

```
C(0, 0) = 100 · ln(e^0 + e^0)
        = 100 · ln(1 + 1)
        = 100 · ln(2)
        = 100 · 0.693
        = 69.3 BTN
```

**Initial prices:**

```
p₁ = e^0 / (e^0 + e^0) = 1/2 = 0.50 (50%)
p₂ = e^0 / (e^0 + e^0) = 1/2 = 0.50 (50%)
```

### Step 2: First Bet - Trader Buys 20 Shares of Team A

**New state:**

```
q' = (20, 0)
```

**New cost:**

```
C(20, 0) = 100 · ln(e^(20/100) + e^0)
         = 100 · ln(e^0.2 + 1)
         = 100 · ln(1.2214 + 1)
         = 100 · ln(2.2214)
         = 100 · 0.7981
         = 79.81 BTN
```

**Cost to trader:**

```
Cost = C(20, 0) - C(0, 0)
     = 79.81 - 69.3
     = 10.51 BTN
```

**New prices:**

```
p₁ = e^0.2 / (e^0.2 + e^0) = 1.2214 / 2.2214 = 0.550 (55.0%)
p₂ = e^0 / (e^0.2 + e^0) = 1 / 2.2214 = 0.450 (45.0%)
```

**Observations:**

- Trader paid **10.51 BTN** for 20 shares
- Average price: **0.525 BTN per share**
- Team A's probability increased from 50% → 55%
- Team B's probability decreased from 50% → 45%

### Step 3: Second Bet - Another Trader Buys 30 More Shares of Team A

**New state:**

```
q' = (50, 0)
```

**New cost:**

```
C(50, 0) = 100 · ln(e^0.5 + e^0)
         = 100 · ln(1.6487 + 1)
         = 100 · ln(2.6487)
         = 100 · 0.9741
         = 97.41 BTN
```

**Cost to second trader:**

```
Cost = C(50, 0) - C(20, 0)
     = 97.41 - 79.81
     = 17.60 BTN
```

**New prices:**

```
p₁ = e^0.5 / (e^0.5 + e^0) = 1.6487 / 2.6487 = 0.622 (62.2%)
p₂ = e^0 / (e^0.5 + e^0) = 1 / 2.6487 = 0.378 (37.8%)
```

**Observations:**

- Second trader paid **17.60 BTN** for 30 shares
- Average price: **0.587 BTN per share** (higher than first trader!)
- Team A's probability increased from 55% → 62.2%
- Prices increase as more people bet on the same outcome

### Step 4: Contrarian Bet - Trader Buys 40 Shares of Team B

**New state:**

```
q' = (50, 40)
```

**New cost:**

```
C(50, 40) = 100 · ln(e^0.5 + e^0.4)
          = 100 · ln(1.6487 + 1.4918)
          = 100 · ln(3.1405)
          = 100 · 1.1447
          = 114.47 BTN
```

**Cost to contrarian trader:**

```
Cost = C(50, 40) - C(50, 0)
     = 114.47 - 97.41
     = 17.06 BTN
```

**New prices:**

```
p₁ = e^0.5 / (e^0.5 + e^0.4) = 1.6487 / 3.1405 = 0.525 (52.5%)
p₂ = e^0.4 / (e^0.5 + e^0.4) = 1.4918 / 3.1405 = 0.475 (47.5%)
```

**Observations:**

- Market rebalanced towards 50/50
- Paro Panthers bet brought probabilities closer together
- Contrarian betting is more expensive (higher average price per share)

### Comparison with Oro's Current System

**Same scenario in Oro's parimutuel**:

```typescript
// State after all bets
market.totalPool = 50 + 50 + 100 = 200 BTN
outcomes[0].totalBetAmount = 100 BTN (Thimphu Tigers)
outcomes[1].totalBetAmount = 100 BTN (Paro Panthers)

// Calculate odds using Oro's formula
payoutPool = 200 * (1 - 0.05) = 190 BTN

odds[Tigers] = 190 / 100 = 1.90x
odds[Panthers] = 190 / 100 = 1.90x

// Payout if Tigers win
// Traders 1 & 2 share the payout pool proportionally
Trader1Payout = (50 / 100) * 190 = 95 BTN (profit: 45 BTN)
Trader2Payout = (50 / 100) * 190 = 95 BTN (profit: 45 BTN)
Trader3 = 0 BTN (lost 100 BTN)
```

**Key Difference:**

- **LMSR**: Shows probabilities and expected values during betting
- **Oro's Parimutuel**: Final odds only known at market close
- **Both**: Same total payout (pool redistribution)

---

## Integrating LMSR with Oro's Parimutuel System

### Why Consider LMSR for Oro?

**Current Pain Points:**

1. **Undefined initial odds** (0/0 division)

### Python Implementation

```python
import math
from typing import List, Tuple

class LMSRMarket:
    """Logarithmic Market Scoring Rule implementation"""

    def __init__(self, num_outcomes: int, liquidity: float):
        """
        Initialize LMSR market

        Args:
            num_outcomes: Number of possible outcomes
            liquidity: Liquidity parameter b (in currency units)
        """
        self.num_outcomes = num_outcomes
        self.b = liquidity
        self.shares = [0.0] * num_outcomes  # Outstanding shares per outcome

    def cost(self, shares: List[float]) -> float:
        """
        Calculate cost function C(q)

        Args:
            shares: List of outstanding shares for each outcome

        Returns:
            Cost in currency units
        """
        exp_sum = sum(math.exp(q / self.b) for q in shares)
        return self.b * math.log(exp_sum)

    def current_cost(self) -> float:
        """Get current cost of market state"""
        return self.cost(self.shares)

    def prices(self) -> List[float]:
        """
        Calculate current probability/price for each outcome

        Returns:
            List of probabilities (sum to 1.0)
        """
        exp_values = [math.exp(q / self.b) for q in self.shares]
        total = sum(exp_values)
        return [exp_val / total for exp_val in exp_values]

    def cost_of_trade(self, outcome: int, shares_to_buy: float) -> float:
        """
        Calculate cost to buy shares of a specific outcome

        Args:
            outcome: Index of outcome (0-based)
            shares_to_buy: Number of shares to purchase

        Returns:
            Cost in currency units
        """
        # Current state
        current = self.cost(self.shares)

        # New state after trade
        new_shares = self.shares.copy()
        new_shares[outcome] += shares_to_buy
        new = self.cost(new_shares)

        return new - current

    def execute_trade(self, outcome: int, shares_to_buy: float) -> Tuple[float, List[float]]:
        """
        Execute a trade and update market state

        Args:
            outcome: Index of outcome to buy
            shares_to_buy: Number of shares to purchase

        Returns:
            Tuple of (cost_paid, new_prices)
        """
        cost = self.cost_of_trade(outcome, shares_to_buy)
        self.shares[outcome] += shares_to_buy
        return cost, self.prices()

    def payout(self, winning_outcome: int, user_shares: List[float]) -> float:
        """
        Calculate payout for user's shares

        Args:
            winning_outcome: Index of winning outcome
            user_shares: User's shares for each outcome

        Returns:
            Payout amount
        """
        # In LMSR, each winning share pays 1 unit
        return user_shares[winning_outcome]

    def market_maker_profit(self, winning_outcome: int) -> float:
        """
        Calculate market maker's profit/loss

        Args:
            winning_outcome: Index of winning outcome

        Returns:
            Profit (positive) or loss (negative)
        """
        # Money in: current cost
        money_in = self.current_cost()

        # Money out: outstanding winning shares
        money_out = self.shares[winning_outcome]

        return money_in - money_out


# Example usage
def example_market():
    # Create 2-outcome market with 100 BTN liquidity
    market = LMSRMarket(num_outcomes=2, liquidity=100.0)

    print("Initial Market State")
    print(f"Shares: {market.shares}")
    print(f"Prices: {[f'{p:.3f}' for p in market.prices()]}")
    print(f"Cost: {market.current_cost():.2f} BTN\n")

    # First trade: Buy 20 shares of outcome 0
    cost1, prices1 = market.execute_trade(outcome=0, shares_to_buy=20)
    print(f"Trade 1: Buy 20 shares of outcome 0")
    print(f"Cost: {cost1:.2f} BTN")
    print(f"New prices: {[f'{p:.3f}' for p in prices1]}")
    print(f"Shares: {market.shares}\n")

    # Second trade: Buy 30 more shares of outcome 0
    cost2, prices2 = market.execute_trade(outcome=0, shares_to_buy=30)
    print(f"Trade 2: Buy 30 shares of outcome 0")
    print(f"Cost: {cost2:.2f} BTN")
    print(f"New prices: {[f'{p:.3f}' for p in prices2]}")
    print(f"Shares: {market.shares}\n")

    # Third trade: Buy 40 shares of outcome 1
    cost3, prices3 = market.execute_trade(outcome=1, shares_to_buy=40)
    print(f"Trade 3: Buy 40 shares of outcome 1")
    print(f"Cost: {cost3:.2f} BTN")
    print(f"New prices: {[f'{p:.3f}' for p in prices3]}")
    print(f"Shares: {market.shares}\n")

    # Simulate outcome 0 wins
    print("=== Market Resolution: Outcome 0 Wins ===")
    mm_profit = market.market_maker_profit(winning_outcome=0)
    print(f"Market maker profit/loss: {mm_profit:.2f} BTN")
    print(f"(Bounded by ±b = ±{market.b} BTN)")


if __name__ == "__main__":
    example_market()
```

### TypeScript/JavaScript Implementation

```typescript
interface LMSRMarketState {
  shares: number[];
  b: number;
  numOutcomes: number;
}

class LMSRMarket {
  private shares: number[];
  private b: number;
  private numOutcomes: number;

  constructor(numOutcomes: number, liquidity: number) {
    this.numOutcomes = numOutcomes;
    this.b = liquidity;
    this.shares = new Array(numOutcomes).fill(0);
  }

  /**
   * Calculate cost function C(q)
   */
  private cost(shares: number[]): number {
    const expSum = shares.reduce((sum, q) => sum + Math.exp(q / this.b), 0);
    return this.b * Math.log(expSum);
  }

  /**
   * Get current market prices/probabilities
   */
  prices(): number[] {
    const expValues = this.shares.map((q) => Math.exp(q / this.b));
    const total = expValues.reduce((sum, exp) => sum + exp, 0);
    return expValues.map((exp) => exp / total);
  }

  /**
   * Calculate cost to buy shares
   */
  costOfTrade(outcome: number, sharesToBuy: number): number {
    const currentCost = this.cost(this.shares);

    const newShares = [...this.shares];
    newShares[outcome] += sharesToBuy;
    const newCost = this.cost(newShares);

    return newCost - currentCost;
  }

  /**
   * Execute trade and update state
   */
  executeTrade(
    outcome: number,
    sharesToBuy: number,
  ): {
    cost: number;
    prices: number[];
  } {
    const cost = this.costOfTrade(outcome, sharesToBuy);
    this.shares[outcome] += sharesToBuy;

    return {
      cost,
      prices: this.prices(),
    };
  }

  /**
   * Calculate payout for winning shares
   */
  payout(winningOutcome: number, userShares: number[]): number {
    return userShares[winningOutcome];
  }

  /**
   * Get market state
   */
  getState(): LMSRMarketState {
    return {
      shares: [...this.shares],
      b: this.b,
      numOutcomes: this.numOutcomes,
    };
  }
}

// Example usage
const market = new LMSRMarket(2, 100);
console.log("Initial prices:", market.prices());

const trade1 = market.executeTrade(0, 20);
console.log("After buying 20 shares of outcome 0:");
console.log("  Cost:", trade1.cost.toFixed(2), "BTN");
console.log(
  "  Prices:",
  trade1.prices.map((p) => (p * 100).toFixed(1) + "%"),
);
```

---

## Liquidity Parameter b

### What is b?

The liquidity parameter **b** is the most important tuning parameter in LMSR. It represents:

- **Market depth**: How much money moves prices
- **Market maker subsidy**: Maximum potential loss
- **Price sensitivity**: How quickly prices respond to trades

### Mathematical Role

In the formula `C(q) = b · ln(Σ e^(qᵢ/b))`:

- **Larger b** → Slower price movement, deeper liquidity
- **Smaller b** → Faster price movement, shallower liquidity

### Choosing b

**Rule of thumb**: Set b to your **maximum acceptable loss**.

```
Maximum Market Maker Loss ≈ b · ln(n)
```

Where n = number of outcomes.

**Examples:**

| Outcomes (n) | Max Loss | b needed |
| ------------ | -------- | -------- |
| 2            | 100 BTN  | 144 BTN  |
| 3            | 100 BTN  | 91 BTN   |
| 4            | 100 BTN  | 72 BTN   |
| 5            | 100 BTN  | 62 BTN   |

**Calculation:**

```
b = Max Loss / ln(n)

For 2 outcomes, $100 max loss:
b = 100 / ln(2) = 100 / 0.693 = 144.27 BTN
```

### Effect on Trading

**Small b (e.g., b = 10):**

```python
# Market: (0, 0) → (10, 0)
Cost = 10 · (ln(e^1 + 1) - ln(2))
     = 10 · (ln(3.72) - ln(2))
     = 10 · (1.31 - 0.69)
     = 6.2 BTN for 10 shares
Average: 0.62 BTN/share
```

**Large b (e.g., b = 1000):**

```python
# Market: (0, 0) → (10, 0)
Cost = 1000 · (ln(e^0.01 + 1) - ln(2))
     = 1000 · (ln(2.01) - ln(2))
     = 1000 · (0.698 - 0.693)
     = 5.0 BTN for 10 shares
Average: 0.50 BTN/share
```

**Observation**: Larger b keeps prices closer to 50% longer, providing deeper liquidity.

### Practical Guidelines

1. **Low-Volume Markets**: Use smaller b (10-50)
   - Prices respond quickly to signals
   - Less capital at risk
   - Good for experimental/niche markets

2. **High-Volume Markets**: Use larger b (100-1000)
   - Deeper liquidity
   - Smoother price discovery
   - Better for popular events

3. **Risk Management**: Never set b > your loss tolerance
   - If you can afford to lose 500 BTN, don't set b > 500
   - Monitor actual market maker position regularly

---

## Edge Cases & Considerations

### 1. Numerical Overflow

**Problem**: `exp(qᵢ/b)` can overflow for large qᵢ values.

**Solution**: Use log-sum-exp trick:

```python
def log_sum_exp(values):
    """Numerically stable log(sum(exp(values)))"""
    max_val = max(values)
    return max_val + math.log(sum(math.exp(v - max_val) for v in values))

def cost_stable(shares, b):
    """Numerically stable cost calculation"""
    scaled = [q / b for q in shares]
    return b * log_sum_exp(scaled)
```

### 2. Rounding Errors

**Problem**: Floating-point precision can cause prices to not sum to exactly 1.0.

**Solution**: Normalize prices explicitly:

```python
def prices_normalized(shares, b):
    exp_values = [math.exp(q / b) for q in shares]
    total = sum(exp_values)
    prices = [exp_val / total for exp_val in exp_values]

    # Ensure sum is exactly 1.0
    error = 1.0 - sum(prices)
    prices[0] += error  # Adjust first outcome

    return prices
```

### 3. Zero Liquidity (b = 0)

**Problem**: Division by zero when b = 0.

**Solution**: Enforce minimum liquidity:

```python
MIN_LIQUIDITY = 1.0  # Minimum 1 currency unit

def create_market(num_outcomes, requested_liquidity):
    b = max(requested_liquidity, MIN_LIQUIDITY)
    return LMSRMarket(num_outcomes, b)
```

### 4. Negative Shares

**Problem**: Can users sell shares they don't own (short selling)?

**Options:**

- **Allow shorting**: Track negative shares, requires margin/collateral
- **Disallow shorting**: Only allow trades that increase outstanding shares
- **Hybrid**: Allow limited shorting with proper risk management

**Implementation:**

```python
def execute_trade_no_short(self, outcome, shares_to_buy):
    # Only allow buying (positive shares_to_buy)
    if shares_to_buy <= 0:
        raise ValueError("Cannot sell/short in this market")

    cost = self.cost_of_trade(outcome, shares_to_buy)
    self.shares[outcome] += shares_to_buy
    return cost
```

### 5. Market Resolution

**Problem**: What happens when the market closes and outcome is determined?

**Process:**

1. Stop accepting new trades
2. Determine winning outcome
3. Calculate payouts: winners get 1 unit per share
4. Calculate market maker profit/loss
5. Distribute funds

**Code:**

```python
def resolve_market(self, winning_outcome, user_positions):
    """
    Resolve market and calculate all payouts

    Args:
        winning_outcome: Index of winning outcome
        user_positions: Dict[user_id -> List[shares_owned]]

    Returns:
        Dict[user_id -> payout_amount]
    """
    payouts = {}

    for user_id, shares in user_positions.items():
        # Winner gets 1 unit per winning share
        payout = shares[winning_outcome]
        payouts[user_id] = payout

    # Calculate house profit/loss
    money_in = self.current_cost()
    money_out = self.shares[winning_outcome]
    house_result = money_in - money_out

    return {
        'user_payouts': payouts,
        'house_profit': house_result,
        'total_shares': self.shares,
        'winning_outcome': winning_outcome
    }
```

### 6. Early Market Maker Depletion

**Problem**: Market maker runs out of funds before market closes.

**Prevention:**

```python
def validate_trade(self, outcome, shares_to_buy, max_exposure):
    """Check if trade exceeds risk limits"""
    cost = self.cost_of_trade(outcome, shares_to_buy)

    # Check against maximum exposure
    if cost > max_exposure:
        raise ValueError(f"Trade cost {cost} exceeds limit {max_exposure}")

    # Check potential max loss
    test_shares = self.shares.copy()
    test_shares[outcome] += shares_to_buy

    max_loss = max(test_shares) - self.cost(test_shares)

    if max_loss > self.b * 1.1:  # 10% buffer
        raise ValueError("Trade would exceed bounded loss guarantee")

    return cost
```

### 7. Precision Requirements

**Recommendations:**

- Use `Decimal` type in Python for financial calculations
- Store shares as integers (multiply by 10^6 for precision)
- Round final outputs consistently

```python
from decimal import Decimal, getcontext

getcontext().prec = 28  # High precision

class LMSRMarketDecimal:
    def __init__(self, num_outcomes, liquidity):
        self.b = Decimal(str(liquidity))
        self.shares = [Decimal('0')] * num_outcomes
```

### 8. Front-Running Protection

**Problem**: Bots can see pending transactions and front-run them.

**Solutions:**

- Batch trades (process all trades in a block simultaneously)
- Commit-reveal scheme
- MEV protection mechanisms
- Fair ordering protocols

### 9. Market Manipulation

**Concerns:**

- Wash trading (buying/selling to yourself)
- Price manipulation near resolution
- Coordinated attacks

**Mitigations:**

- Minimum time between trades
- Maximum trade size limits
- Monitor for suspicious patterns
- Require identity verification for large trades

---

## Further Reading

### Academic Papers

1. **Hanson, R. (2003)** - "Combinatorial Information Market Design"
2. **Hanson, R. (2007)** - "Logarithmic Market Scoring Rules for Modular Combinatorial Information Aggregation"
3. **Chen, Y. & Pennock, D. (2007)** - "A Utility Framework for Bounded-Loss Market Makers"

### Online Resources

- [Gnosis Whitepaper](https://gnosis.io) - Real-world LMSR implementation
- [Augur Documentation](https://augur.net) - Decentralized prediction markets
- [Prediction Market FAQ](https://www.prediction-markets.com)

### Related Mechanisms

- **Constant Product Market Maker (CPMM)**: Used by Uniswap
- **Constant Function Market Maker (CFMM)**: Generalized AMM framework
- **Dynamic Parimutuel Market (DPM)**: Hybrid approach

---

## Conclusion

LMSR is a powerful mechanism for creating liquid prediction markets with bounded risk. Its mathematical elegance ensures proper incentives while providing continuous liquidity. For practical implementations, especially in parimutuel-style betting platforms, consider hybrid approaches that combine LMSR's pricing advantages with traditional pool-based payouts.

**Key Takeaways:**

- LMSR provides instant liquidity through an automated market maker
- The parameter **b** controls both liquidity depth and maximum risk
- Prices are derived from the softmax of outstanding shares
- Implementation requires careful attention to numerical stability
- Hybrid models can combine LMSR pricing with parimutuel payouts

For your Oro platform, we recommend using LMSR for **odds display** while maintaining **traditional parimutuel** mechanics for payouts, giving users familiar outcomes while improving the betting experience with live odds.

---

_Last updated: March 23, 2026_
_For implementation questions: See `/docs/` directory for more guides_
