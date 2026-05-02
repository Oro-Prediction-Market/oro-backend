# Oro — Frequently Asked Questions

> Last Updated: April 2026

---

## Table of Contents

**User Questions**
1. [Getting Started](#getting-started)
2. [Betting & Markets](#betting--markets)
3. [Wallet & Payments](#wallet--payments)
4. [Duels (1v1 Challenges)](#duels-1v1-challenges)
5. [Streaks & Power Cards](#streaks--power-cards)
6. [Profile, Badges & Referrals](#profile-badges--referrals)
7. [Disputes](#disputes)
8. [Web (PWA) Access](#web-pwa-access)
9. [Privacy & Data](#privacy--data)

**Admin Questions**
10. [Market Management](#market-management-admin)
11. [Keeper Automation](#keeper-automation)
12. [Users & Accounts](#users--accounts)
13. [Financial & Reconciliation](#financial--reconciliation)

---

## Getting Started

### Do I need to create an account to use Oro?

No. Your account is created automatically the first time you open the Oro Mini App inside Telegram. Your Telegram username and display name are used directly — there is no sign-up form.

### Why do I need to link my DK Bank account?

DK Bank is the payment gateway used to move real money in and out of the platform. You need to link it before you can deposit or withdraw. To link it, go to **Profile → Link DK Bank** and enter your 11-digit Bhutanese Citizenship ID (CID). Your phone number is then verified with an OTP.

You do not need DK Bank to browse markets or watch the platform — only to place bets with real money.

### Can I use Oro without a Telegram account?

Oro's primary interface is the Telegram Mini App, so a Telegram account is required for most users. However, you can set a PWA password in **Settings → Website Access** and then log in at the web version of Oro without opening Telegram each time. See [Web (PWA) Access](#web-pwa-access) for details.

### What is a CID?

CID stands for Citizenship Identity number — the 11-digit ID number on your Bhutanese citizenship identity card. It is required by DK Bank to verify your identity before you can deposit or withdraw real money.

---

## Betting & Markets

### How does parimutuel betting work?

In a parimutuel market, all stakes from all users go into a single shared pool. When the market resolves, the total pool (minus the house edge) is distributed proportionally among everyone who bet on the winning outcome.

**Example:** The market pool is Nu 10,000. The house edge is 5%, so the payout pool is Nu 9,500. You staked Nu 500 on the winning outcome, which attracted 25% of all stakes on that side. Your payout is 25% of Nu 9,500 = Nu 2,375.

### Why do the odds change after I place my bet?

Because odds in Oro are not fixed. They shift in real time as more bets come in. When more people bet on the same outcome as you, your potential payout multiplier decreases (your share of the pool shrinks). When fewer people bet on your outcome, the multiplier increases. This is the core mechanic of a parimutuel pool.

### Can I cancel or change my bet after placing it?

No. All bets are final once confirmed. You cannot cancel, adjust, or withdraw a bet from a market while it is still open.

### What happens to my bet if a market is cancelled?

If an admin cancels a market, all stakes are fully refunded to each user's Oro wallet. No deductions are made.

### When does a market close?

Each market has a **closing time** set by the admin, displayed on the market card and detail page. Once the deadline passes, no new bets are accepted. The market then moves to `closed` status and awaits resolution.

### What is the house edge?

The house edge is the percentage of the total pool that the platform keeps before distributing payouts to winners. It is set per market by admins and is visible on the Market Detail page before you bet. A typical house edge is around 3–10%.

### What does "resolving" status mean?

After a market closes, an admin proposes the winning outcome. The market enters `resolving` status, and a **dispute window** opens (typically 60 minutes). During this window, users who held a position can file an objection if they believe the proposed outcome is wrong. If no valid objection is upheld, the market automatically confirms and payouts are distributed.

### How long does it take to receive my winnings after a market resolves?

Payouts are distributed automatically by the Keeper service. Once the dispute window closes and the market moves to `resolved`, your winnings appear in your Oro wallet within minutes. You will see a **Bet Payout** entry in your transaction history.

---

## Wallet & Payments

### What is the minimum deposit?

The minimum deposit is **Nu 50** per transaction.

### What is the maximum deposit?

The maximum deposit is **Nu 15,000** per transaction.

### What is the minimum withdrawal?

The minimum withdrawal is **Nu 50** per transaction.

### How long does a withdrawal take?

Withdrawals are processed through DK Bank and are typically near-instant during bank operating hours. Processing may be slower outside standard hours or during high-traffic periods.

### What is the first deposit bonus?

Your very first deposit receives a **+10% bonus** added to your wallet. For example, depositing Nu 1,000 gives you Nu 1,100 in your Oro balance. This bonus is applied automatically and appears in your transaction history.

### What is the difference between real balance and bonus balance?

- **Real balance** — funds you deposited through DK Bank, plus any cash winnings. This balance can be withdrawn.
- **Bonus balance** — credits earned from referral bonuses, streak rewards, and promotional credits. Bonus credits can be used to place bets but cannot be withdrawn directly as cash.

### What payment methods are supported?

| Method | Use case |
|--------|---------|
| **Oro Wallet (Nu credits)** | Instant payment from your existing balance |
| **DK Bank** | Deposit and withdraw Bhutanese Ngultrum directly |
| **TON** | Cryptocurrency deposits via a TON Connect wallet |

### My deposit went through on DK Bank but my Oro balance did not update. What do I do?

First, wait a few minutes and refresh the wallet page. If the balance still does not appear, contact support via **Settings → Support** with your DK Bank transaction reference number. The Payment Logs in the admin portal can be used to trace the transaction.

---

## Duels (1v1 Challenges)

### What is a Duel?

A Duel is a 1v1 side-bet between two users on opposite outcomes of a market. You must have already placed a bet on a market to create a Duel on it. The creator picks one outcome; the first person to accept automatically takes the opposite side. The winner takes both wagers (minus the platform fee).

### Why can't I create a Duel yet?

You need to have placed at least **5 predictions** before you can create your first Duel. This prevents new users from jumping straight to Duels without understanding how the markets work. Your progress is shown on the Duels page under the eligibility gate.

### What is the platform fee on Duels?

A **10% platform fee** is deducted from the combined pot before paying the winner. For example, if both players wager Nu 500, the pot is Nu 1,000 and the winner receives Nu 900.

The fee is **waived entirely** if you use the **Double Down** power card — the winner takes the full Nu 1,000.

### Can I set a wager of zero?

Yes. You can create a Duel with a **Nu 0 wager** if you want a bragging-rights-only challenge with no money at stake.

### What happens if nobody accepts my Duel before the market closes?

Your Duel moves to `expired` status and your wager is returned to your wallet automatically.

### Can I cancel a Duel I created?

You cannot cancel a Duel once it is posted to the open feed. If no one accepts it before the market closes, it expires automatically and your wager is returned.

### What happens to a Duel if the underlying market is cancelled?

The Duel is voided and all locked wagers are returned to both participants.

### How do I get Power Cards?

Power cards (Double Down, Shield, Ghost) are unlocked by reaching duel win milestones. The exact milestones are shown on the Duels page. Each card can be used once per duel when creating or accepting.

---

## Streaks & Power Cards

### How does the bet streak work?

Place at least one bet on any open market each calendar day to increment your streak. The streak resets to 0 if you go a full day without placing a bet. Your current streak count is shown on the Feed, the Profile page, and inside the Bet Modal.

### What is the day-7 bonus?

When you reach day 7 of a consecutive streak, your payout on bets placed that day receives a **1.2× multiplier** — you earn 20% more on any winning bet. After day 7, the cycle resets and your streak counter continues building toward the next 7-day cycle.

### What happens if I miss a day?

Your streak resets to 0. The only exception is if you hold a **Shield** power card — using it protects your streak for one missed day (the counter continues as if you had bet that day).

### Do I need to win my bets to keep a streak?

No. You only need to **place** at least one bet per day. Whether that bet wins or loses does not affect your streak.

---

## Profile, Badges & Referrals

### How are reputation tiers calculated?

Tiers are based on your **Brier score**, a statistical measure of prediction calibration. It considers both how often you are correct and how confident (i.e., how much you stake) your predictions are. Tiers in ascending order: **Rookie → Sharpshooter → Hot Hand → Legend**.

### How do I earn collectible badges?

Badges unlock automatically when you hit specific milestones — no action required. A pop-up notification appears on your Profile page when a new badge unlocks. All badges are viewable in the badge cabinet on your Profile.

Examples of milestones that unlock badges:

| Badge | Milestone |
|-------|-----------|
| First Call | Place your first prediction |
| Ten Deep | Make 10 predictions |
| Eagle Eye | Achieve >65% accuracy |
| Bankrolled | Link your DK Bank account |
| Challenger | Complete your first Duel |
| Ambassador | Refer 5 friends |

### How does the referral bonus work?

Share your referral link from **Profile** or **Settings**. When a friend opens Oro through your link and places their first bet:

- You receive a **flat Nu 25 bonus**.
- Plus **5% of their first bet amount** as an additional bonus.
- The total referral bonus is **capped at Nu 75** per referee.

Referral bonuses are credited as bonus balance.

### Can I share my bet with friends?

Yes. After placing a bet, a **Bet Share Card** appears with a share button. This opens the Telegram share sheet so you can forward the card to any contact or group. The card shows your prediction and includes your referral link, so any friend who signs up through it counts toward your referral total.

---

## Disputes

### What is a dispute?

After a market closes and an admin proposes a winning outcome, a **dispute window** opens (typically 60 minutes). If you held a position on that market and believe the proposed outcome is incorrect, you can file an objection. The admin reviews each objection and either upholds (outcome gets reconsidered) or rejects it.

### What does it cost to file an objection?

Filing an objection requires a **fixed bond of Nu 5,000** locked from your wallet. This bond is designed to deter frivolous or bad-faith objections.

### What happens if my objection is upheld?

Your bond is returned in full, and you receive a share of the **forfeited bonds** from other users whose objections were rejected. The market outcome may be changed if the admin agrees the resolution was incorrect.

### What happens if my objection is rejected?

Your bond of Nu 5,000 is **forfeited** to the reward pool, which is distributed among users who filed correct objections on the same market.

### Can I file more than one objection on the same market?

No. Each user can file at most one objection per market.

### Who can file an objection?

Only users who held an active position (placed a bet) on the market can file an objection against its proposed outcome.

---

## Web (PWA) Access

### Can I use Oro without opening Telegram every time?

Yes. Set a PWA password in **Settings → Website Access**. Enter a password (minimum 6 characters) and confirm it. Once set, you can log in to the web version of Oro at `oro.app` using your Telegram username and this password, without needing to open Telegram.

### Is the web version the same as the Telegram Mini App?

The web version (PWA) uses the same backend and wallet as the Telegram Mini App. All your bets, balance, duels, and profile carry over. Some Telegram-specific features (like the back button and native sharing sheet) behave slightly differently in the browser.

---

## Privacy & Data

### What personal data does Oro collect?

Oro collects:
- Your Telegram ID, username, and display name (provided by Telegram on login)
- Your Bhutanese CID (for DK Bank identity verification)
- Your phone number (verified via OTP for DK Bank transactions)
- Bet history, transaction records, and wallet balance
- Session tokens and IP address for security

We do **not** collect or store your bank PIN, full bank credentials, or any payment card details.

### Is my data shared with third parties?

Data is shared only with:
- **DK Bank** — for processing deposits and withdrawals (transaction references only)
- **TON Blockchain** — withdrawal transactions are broadcast publicly on-chain
- **Telegram** — the platform through which the Mini App is delivered
- Infrastructure and hosting providers under data processing agreements

We do not sell your data.

### How long is my data retained?

Financial records (transactions, bets, settlements) are retained for as long as legally required. Account data is retained while your account is active. See the full [Privacy Policy](PRIVACY_POLICY.md) for retention periods by data type.

### How do I request deletion of my account or data?

Contact support via **Settings → Support** in the app. Requests are handled in accordance with applicable Bhutanese data protection requirements.

---

## Market Management (Admin)

### What is the difference between cancelling and closing a market?

- **Closing** — the betting window ends; the market moves to `closed` and awaits resolution. No refunds are issued.
- **Cancelling** — the market is voided entirely; all bets are refunded to users. Use this when an event is called off or when the market was created in error.

### Can I edit a market after bets have been placed?

You can edit the title, description, closing time, and outcome images at any time while the market is `open`. You **cannot** change the list of outcomes or the house edge percentage once any bets have been placed.

### What is the dispute window and can I change its duration?

The dispute window is the period after an outcome is proposed during which users can file objections. The default is **60 minutes**. When proposing a resolution in the Resolve Market modal, admins can configure a different duration. The minimum allowed window is 60 minutes.

### Can I change the winning outcome after I've already proposed it?

Not directly. Once an outcome is proposed, the dispute process is the mechanism for reconsidering it. If you made an error, the cleanest path is to uphold any incoming objection and re-propose the correct outcome, or to contact your platform's technical lead to correct the record.

### What happens if the Keeper settles a market with the wrong outcome?

Open the Resolution Log to identify the settlement. Contact your platform's technical team — a manual correction and re-settlement will be required. All such actions are captured in the Audit Log.

### What categories are available for markets?

Sports, Politics, Weather, Entertainment, Economy, and Other.

---

## Keeper Automation

### What does the Keeper do?

The Keeper is a background service that automates time-sensitive operations:
- **Closes markets** that have passed their deadline
- **Opens dispute windows** on markets whose outcomes have been proposed
- **Auto-settles** resolved markets (distributes payouts) once the dispute window expires with no upheld objections

It runs on a scheduled cycle. You can monitor its activity and trigger individual jobs manually from the Keeper Dashboard.

### What happens if the Keeper is paused?

Markets will not be closed, dispute windows will not open, and settlements will not run automatically. Payouts to users will be delayed. Use the manual trigger buttons on the Keeper Dashboard to run individual jobs while investigating why the Keeper is paused. Re-enable it as soon as possible.

### The Keeper log shows errors. What should I do?

Check the error message for context (e.g. database connection failure, external service timeout). The Keeper Dashboard colour-codes log entries: **red = error**, **orange = warning**, **green = success**, **blue = info**. Persistent errors may require checking server health or backend logs.

---

## Users & Accounts

### Can I grant admin access to a user?

Yes. In **User Management**, expand the user's row and click **Grant Admin**. This gives the user access to the Admin Portal. This action is logged in the Audit Log. Revoke admin access the same way.

### Can I delete a user account?

User deletion is not available through the Admin Portal UI. For account deletion requests (e.g. from users invoking their data rights), contact your platform's technical team to handle it at the database level.

### Can I see a user's wallet balance or bet history?

The User Management page shows each user's reputation tier, prediction count, and streak. Detailed financial history (wallet balance, bet history) is available through the Settlement and Payment Logs pages, filtered by user.

---

## Financial & Reconciliation

### What is a reconciliation discrepancy?

A discrepancy means the platform's accounting equation does not balance:

```
Net deposits in − active bets − user wallet balances − house earnings ≠ 0
```

This can be caused by a failed transaction that was not properly rolled back, a settlement error, or a data migration issue. Any non-zero discrepancy should be investigated immediately. Contact your technical team with the reconciliation snapshot timestamp.

### What is "breakage"?

Breakage is the tiny fractional amount that remains after payouts are divided among winning bettors. Because payouts are rounded to the nearest currency unit, a few paisa may not be distributable. Breakage stays with the platform and is tracked in the Settlement page and Reconciliation panel.

### What does "net external flow" mean in reconciliation?

Net external flow = total DK Bank deposits received − total withdrawals paid out. It represents the real money the platform has taken in from the outside world, net of what has been returned. This should roughly equal the sum of all user real balances plus active bet amounts plus house earnings.
