# Oro Market Mechanisms Guide

This guide explains how the prediction algorithms work on the Oro platform, how they handle real-time probabilities, and how to switch between them.

## 1. What is House Edge (%)?

The **House Edge** is the percentage of the betting volume that the platform (Oro) retains as a fee for hosting the market. 

- **How it works:** If the House Edge is set to `5%`, and Nu. 10,000 is wagered into the market, Nu. 500 is kept by the platform, and Nu. 9,500 is added to the actual betting pool to be paid out to the winners.
- **Why it matters:** It serves as the revenue model for the platform. A lower house edge attracts more bettors, while a higher house edge generates more revenue per bet but may discourage whales.

---

## 2. Real-Time Probabilities & Odds

Yes, **both mechanisms** track and update the "implied probability" (the odds of an event occurring) in real-time as money enters the pool.

- **In Parimutuel:** As more money comes in for a certain team, their implied probability goes *up*, and the potential payout payout goes *down*. However, since the pool isn't finalized until the end, early bettors are still subject to these shifting odds right up until the market closes.
- **In SCPM (Limit Orders):** As people buy "shares" of a team, the probability/price of that team immediately increases (e.g., from Nu. 30 to Nu. 40 per share). But unlike Parimutuel, whatever price/odds you lock in at the exact moment of your bet is guaranteed to you.

---

## 3. Switching Between Betting Mechanisms

Oro supports two distinct algorithms for handling bets: **Parimutuel** and **SCPM** (Sequential Convex Programming Mechanism). You can choose which one to use **when creating a new market in the Admin Dashboard**.

### Mechanism A: Parimutuel Betting
**Best for:** Standard, simple events where users just want to pick a side without worrying about locking in specific odds.

- **How it works:** All bets on all outcomes are pooled together. The final odds (and payouts) are determined only *after* the market closes, based on the proportion of money wagered on each side.
- **Key trait:** Bettors don't lock in a specific price when they bet. If there is a massive late bet on their side, their potential payout decreases.
- **Bhutanese Football Example:** A Bhutan Premier League match: **"Paro FC vs. Thimphu City FC"**. 
  - Sonam bets Nu. 1,000 on Paro FC on Monday. 
  - By Friday, a ton of other people also bet heavily on Paro FC.
  - Because so much money is on Paro FC, the final payout for a Paro FC win becomes lower. Sonam doesn't mind; he just wanted to casually back his favorite team, and if they win, he will get a proportional cut of whatever total pool (minus house edge) is gathered from the Thimphu City FC bettors.

### Mechanism B: SCPM (Limit Orders)
**Best for:** Advanced trading, giving users guaranteed odds and operating similarly to Polymarket.

- **How it works:** SCPM uses an automated market maker (AMM) math curve. Users can place "Limit Orders" where they specify the exact maximum price/odds they are willing to accept. 
- **Key trait:** Users lock in their odds at the time of the bet. The price dynamically adjusts based on the liquidity parameter.
- **Bhutanese Football Example:** The same match: **"Paro FC vs. Thimphu City FC"**. 
  - Tenzin is an advanced sports trader. He believes Paro FC has a 70% chance of winning, but the market currently prices them at 50% (shares are trading at Nu. 50).
  - Tenzin places a limit order locking in his bet at Nu. 50. 
  - As match day approaches, star players on Thimphu City FC get injured. The rest of the market reacts, buying up Paro FC shares until the price climbs to Nu. 80. 
  - Tenzin is completely protected. His bet was locked in at Nu. 50, so if Paro FC wins, his payout is calculated based on that original cheap price, granting him a massive profit compared to someone who bet late. He actively *traded* the probability ahead of the news.

---

### How to Switch in the Admin UI

1. Open your **Oro Admin Dashboard**.
2. Click **"Create Market"**.
3. Fill out the market details (Title, Outcomes, etc.).
4. Find the **Mechanism** dropdown.
5. Select either **PARIMUTUEL** or **SCPM**.
6. If you selected SCPM, enter a value in the **Liquidity Parameter** field (start with `100` or `1000` for testing).
7. Submit the form to create the market. The backend will automatically route all bets for this market to the correct algorithm!
