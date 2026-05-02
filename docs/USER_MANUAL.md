# Oro — User Manual

> **Version:** 1.0 · **Date:** April 2026
> Covers the Oro Telegram Mini App (user-facing) and the Oro Admin Portal.

---

## Table of Contents

1. [What is Oro?](#1-what-is-oro)
2. [Part A — User App (Telegram Mini App)](#part-a--user-app-telegram-mini-app)
   - [Getting Started](#getting-started)
   - [Home Feed](#home-feed)
   - [Markets](#markets)
   - [Placing a Bet](#placing-a-bet)
   - [Wallet & Payments](#wallet--payments)
   - [Duels (1v1 Challenges)](#duels-1v1-challenges)
   - [Leaderboard](#leaderboard)
   - [Profile, Streaks & Badges](#profile-streaks--badges)
   - [Settings](#settings)
3. [Part B — Admin Portal](#part-b--admin-portal)
   - [Logging In](#logging-in)
   - [Dashboard](#dashboard)
   - [Market Management](#market-management)
   - [Market Discovery](#market-discovery)
   - [Keeper Dashboard](#keeper-dashboard)
   - [User Management](#user-management)
   - [Settlement](#settlement)
   - [Payment Logs](#payment-logs)
   - [Resolution Log](#resolution-log)
   - [Audit Log](#audit-log)
   - [Reconciliation](#reconciliation)
4. [Glossary](#glossary)

---

## 1. What is Oro?

Oro is a **parimutuel prediction market** built for Bhutan and delivered as a **Telegram Mini App**. Users predict the outcome of real-world events — sports, politics, weather, entertainment — stake Oro credits (Nu, pegged to the Bhutanese Ngultrum), and share a payout pool when the market resolves in their favour.

Everything runs inside Telegram. No separate download or account creation is needed. Real-money flow is handled through **DK Bank**, Bhutan's digital payment network.

---

## Part A — User App (Telegram Mini App)

### Getting Started

#### 1. Open the App

Tap the Oro Mini App link inside Telegram (shared by a friend or found via the Oro bot `@OroPredictBot`). The app launches inside Telegram. Your profile is created automatically from your Telegram account — no registration form required.

First-time users see an **onboarding walkthrough** that explains:

| Step | What it covers |
|------|----------------|
| 1 | Link your DK Bank account |
| 2 | Deposit funds into your Oro wallet |
| 3 | Browse markets and predict |
| 4 | How parimutuel odds work |
| 5 | Market resolution and payouts |
| 6 | How Duels (1v1 challenges) work |

You can dismiss the walkthrough and return to it later via **Settings → How It Works**.

#### 2. Link Your DK Bank Account

Before you can deposit real money, you must link your DK Bank account:

1. Go to **Profile** (bottom navigation).
2. Tap **Link DK Bank**.
3. Enter your **11-digit CID** (Citizenship Identity number).
4. Verify your phone number via the OTP sent to your registered mobile.

Once linked, your DK Bank account and phone number are tied to your Oro profile. This is a one-time step.

> Your first deposit receives a **+10% bonus** on the deposited amount.

---

### Home Feed

The **Feed** (`/`) is the default screen when you open Oro. It shows:

- **Live Activity Ticker** — a scrolling banner of recent bets and wins from other users, so you can see what the community is predicting.
- **Open Markets** — cards for all currently open prediction markets. Each card shows the market title, category, closing time, pool size, and outcome options with live odds.
- **Streak Banner** — if you have an active bet streak, your progress toward the 7-day bonus is shown at the top of the feed.

Tap any market card to open the **Market Detail** page.

---

### Markets

The **Markets** page (`/markets`) lists all open markets with filtering options. You can browse by category (Sports, Politics, Weather, Entertainment, Economy, Other) and sort by pool size or closing time.

The **Resolved Markets** page (`/resolved`) shows past markets with their outcomes — useful for checking the platform's resolution history.

#### Market Detail

Tapping a market opens its detail page, which shows:

- **Title & description** — what is being predicted.
- **Closing time** — the deadline for placing bets.
- **Outcomes** — each possible result with its current odds and the percentage of the pool it holds.
- **Pool Details** — total amount staked, house edge, and live odds breakdown.
- **Payout Breakdown** — an estimate of your payout if your chosen outcome wins, based on your stake and the current pool.
- **Place Bet** button — opens the bet modal.

---

### Placing a Bet

1. On the Market Detail page, tap **Place Bet** (or tap an outcome directly).
2. In the **Bet Modal**:
   - Select your **outcome** (e.g. "Team A wins").
   - Enter your **stake amount** in Nu. Quick presets (e.g. 50, 100, 500) are available.
   - Review the **estimated payout** shown below.
3. Tap **Confirm Bet**.
4. If you are paying via DK Bank, a **DK Bank Confirm Modal** appears asking you to approve the debit from your DK Bank account. Enter the OTP when prompted.
5. On success, a **Bet Share Card** appears — you can share your prediction to Telegram contacts or challenge a friend to take the opposite side.

#### Payment Methods

| Method | Notes |
|--------|-------|
| **Oro Wallet (Nu credits)** | Instant. Requires a prior deposit. |
| **DK Bank** | Deducted from your linked DK Bank account. Requires OTP confirmation. |
| **TON** | Crypto payment via TON blockchain (TON Connect wallet required). |

---

### Wallet & Payments

The **Wallet** page (`/wallet`) is your financial hub.

#### Balance

Your balance is shown at the top. Tap the eye icon to hide/show the balance. The balance includes:

- **Real balance** — funded by DK Bank deposits and winnings.
- **Bonus balance** — earned from referral bonuses, streak rewards, and promotional credits.

#### Deposit

1. Tap **+ Deposit**.
2. Enter the amount (minimum Nu 50, maximum Nu 15,000 per transaction).
3. Quick-select presets: Nu 100, 200, 500, 1,000.
4. Tap **Deposit via DK Bank**.
5. An OTP is sent to your registered phone. Enter it to confirm.
6. Funds appear in your Oro balance instantly.

#### Withdraw

1. Tap **Withdraw**.
2. Enter the amount (minimum Nu 50).
3. Confirm with the OTP sent to your phone.
4. Funds are transferred to your linked DK Bank account. Processing is near-instant during bank hours.

#### Transaction History

Below your balance, a **transaction ledger** shows every credit and debit with:

- Type (Top Up, Cash Out, Bet Placed, Bet Payout, Refund, Duel Wager, Duel Payout, Referral Bonus, etc.)
- Amount and direction (green = in, red = out)
- Date and time

Tap any transaction to see its full details.

---

### Duels (1v1 Challenges)

The **Duels** page (`/challenges`) lets you challenge another user to a head-to-head bet on a market you have already predicted.

> **Eligibility:** You must have placed at least **5 predictions** before creating your first duel.

#### Creating a Duel

1. Go to **Duels** in the bottom navigation.
2. Tap **Create Duel**.
3. Select the market and the **outcome you already bet on**.
4. Set a **wager amount** (0, 50, 100, 500, or 1,000 Nu). This is locked from your wallet until the duel settles.
5. Optionally apply a **Power Card** (see below).
6. Tap **Post Duel**. Your duel appears in the **Open Feed** tab.

#### Accepting a Duel

1. Browse the **Open** tab for duels posted by other users.
2. Tap a duel to see its details: market, outcome the challenger picked, wager.
3. Tap **Accept**. You are automatically placed on the opposing outcome.
4. The wager is locked from your wallet. Both sides await market resolution.

#### Duel Tabs

| Tab | Shows |
|-----|-------|
| **Mine** | Duels you created or accepted, with their current status |
| **Open** | All open duels available to accept |
| **Leaderboard** | Top duel performers ranked by wins |

#### Duel Statuses

| Status | Meaning |
|--------|---------|
| Open | Waiting for an opponent |
| Active | Opponent accepted, awaiting market resolution |
| Settled | Market resolved, winner paid out |
| Expired | No opponent accepted before the market closed |
| Void | Duel cancelled (market cancelled or error) |

#### Payouts

- **Winner takes the full pot** (both wagers combined).
- A **10% platform fee** is deducted from the pot by default.
- The fee is **waived** if you play the **Double Down** power card.

#### Power Cards

Power cards are unlocked by reaching duel win milestones. Each card can be used once per duel.

| Card | Effect | How to unlock |
|------|--------|---------------|
| **Double Down** | Platform fee waived — winner takes the full 2× pot | Reach duel win milestones |
| **Shield** | Your bet streak is protected even if you lose this duel | Reach duel win milestones |
| **Ghost** | Your wager is hidden as "???" in the open feed until an opponent accepts | Reach duel win milestones |

---

### Leaderboard

The **Leaderboard** (`/leaderboard`) ranks users by prediction performance.

#### Tabs & Periods

- **Overall** — all-time standings
- **Weekly** — last 7 days
- **Monthly** — last 30 days

#### Tiers

Each user is assigned a reputation tier based on their Brier score (a calibrated accuracy metric):

| Tier | Description |
|------|-------------|
| **Rookie** | Just getting started |
| **Sharpshooter** | Consistently accurate predictor |
| **Hot Hand** | On a strong winning run |
| **Legend** | Elite-level accuracy over many predictions |

Your tier badge and rank are shown on your profile card on the leaderboard. Tap your own entry to see a full breakdown: total predictions, correct calls, accuracy %, win rate, and transaction history.

#### Seasons

Oro runs prediction **seasons** (time-bounded competitive periods). The current season name, start and end dates, and your standing within it are shown at the top of the leaderboard. Past seasons are archived and viewable in the season history.

---

### Profile, Streaks & Badges

#### Profile Page (`/profile`)

Your profile shows:

- **Display name** and Telegram username
- **Reputation tier** badge and score
- **Stats:** total predictions, correct calls, accuracy %, duel record
- **Streak counter** — consecutive days you have placed at least one bet
- **Wallet balance** shortcut
- **Referral stats** — how many users you have invited and any bonus credits earned
- **Collectible Badges** — tap to open your badge cabinet
- **Share Profile** — generates a share card you can post to Telegram

#### Bet Streak

Place at least **one bet per day** to build your streak. The streak banner shows a 7-day progress bar.

- **Day 7 Boost:** On the 7th consecutive day, your payout on that day's bet is multiplied by **1.2×**.
- Missing a day resets your streak to 0.
- Holding a **Shield** power card protects your streak for one missed day.

#### Collectible Badges

Badges are awarded automatically when you hit milestones. They are purely cosmetic collectibles displayed on your profile.

**Badge categories:**

| Category | Examples |
|----------|---------|
| Volume | First Call (1 prediction), Triple Threat (3), Ten Deep (10), Centurion (100) |
| Accuracy | Above Average (>50%), Eagle Eye (>65%), Oracle (>80%), Godlike (>90%) |
| Correct Calls | Right Once (1 correct), Double Digit (10), Half Century (50) |
| Tier | Rookie, Sharpshooter, Hot Hand, Legend |
| Profile | Verified (phone linked), Bankrolled (DK Bank linked), Connected, High Score |
| Referrals | Connector (1 referral), Ambassador (5), Influencer (10), Kingmaker (25) |
| Duels | Challenger (1 duel), On Fire, Duel Master, Dead Eye, Pack Leader, Duel Oracle |

When you unlock a new badge, a pop-up animation appears on your Profile page.

#### Referrals

Your profile contains a **referral link**. Share it with friends. When a referred user signs up and places their first bet, you receive a **referral bonus** credit.

---

### Settings

The **Settings** page (`/settings`) contains:

| Section | Options |
|---------|---------|
| **Account** | Your Telegram username, member since date |
| **DK Bank** | Link status, re-link option |
| **PWA Access** | Set a password to access Oro from a browser (outside Telegram) |
| **How It Works** | Reopen the onboarding guide |
| **Support** | Open a Telegram chat with the support bot |
| **About** | App version, privacy policy link |

---

## Part B — Admin Portal

The Admin Portal (`oro-admin`) is a separate web application for platform operators. It is not accessible to regular users.

### Logging In

Navigate to the Admin Portal URL in a browser. You will see the **Admin Uplink** login screen.

1. Enter the **Dev Secret** (the `ADMIN_DEV_SECRET` environment variable configured on the server).
2. Enter your **TOTP code** from your authenticator app (2FA is required).
3. Click **Login**.

Your session token is stored in `sessionStorage` and expires when you close the browser tab. Click **Logout** in the sidebar to end your session manually.

---

### Dashboard

The Dashboard gives a real-time overview of platform health.

| Stat Card | What it shows |
|-----------|---------------|
| **Active Markets** | Number of markets with `open` status |
| **Total Pool Volume** | Sum of all staked Nu across all markets |
| **Unsettled Markets** | Markets in `closed`, `resolving`, or `resolved` status awaiting payout |

Below the stat cards:

- **Health Check** — live ping to the backend API confirming server availability.
- **Behavioral Analytics** — engagement metrics broken down by bet category, showing where users are most active.

---

### Market Management

The **Market Management** section is the core tool for controlling the prediction market lifecycle.

#### Market Lifecycle

```
open → closed → resolving → resolved → (settled)
                         ↘ cancelled
```

| Status | Meaning |
|--------|---------|
| `open` | Accepting bets |
| `closed` | Betting window ended, awaiting resolution |
| `resolving` | Admin has proposed an outcome, dispute window open |
| `resolved` | Winning outcome confirmed, ready for settlement |
| `settled` | Payouts distributed |
| `cancelled` | Market voided, all stakes refunded |

#### Creating a Market

1. In Market Management, click **+ New Market**.
2. Fill in the **Market Form**:
   - **Title** — the prediction question (e.g. "Will Bhutan qualify for SAFF Championship 2026?")
   - **Description** — context and resolution criteria
   - **Category** — Sports, Politics, Weather, Entertainment, Economy, Other
   - **Closes At** — betting deadline (date + time)
   - **Outcomes** — at least 2 outcome options (e.g. "Yes", "No"). Add images per outcome if desired.
   - **House Edge %** — platform fee taken from the pool before payouts (default set by config)
3. Click **Create**. The market goes live immediately with `open` status.

#### Editing a Market

Click the **Edit** (pencil) icon next to an open market. You can update the title, description, closing time, and outcome images. You cannot change outcomes or house edge after bets have been placed.

#### Closing a Market

When a market's closing time passes, it moves to `closed` automatically. You can also manually close a market early by clicking **Close** on any `open` market.

#### Resolving a Market

1. Click **Resolve** on a `closed` or `resolving` market.
2. In the **Resolve Market Modal**:
   - Select the **winning outcome**.
   - Optionally provide an **evidence URL** and a note.
3. Click **Propose Outcome**. The market enters `resolving` status and a dispute window opens (duration configured per market).
4. If no valid objection is raised within the window, the market auto-confirms and moves to `resolved`.
5. Settlement (payout distribution) runs automatically after resolution.

> **Outcome changed during dispute:** If an objection is upheld and the outcome is overturned, the resolution log records the change.

#### Cancelling a Market

Click **Cancel** on any `open` or `closed` market. Confirm in the **Cancel Market Modal**. All bets are refunded automatically.

#### Live Odds

The **Odds Display** panel shows the current payout multiplier for each outcome in real time, updating as new bets come in. The **Late Money Monitor** flags unusual spikes in staking activity near the closing deadline.

#### Disputes

Markets that have objections filed against their proposed outcome appear in the dispute section of the resolve modal. Admins review each objection and either uphold or reject it.

---

### Market Discovery

The **Market Discovery** tool lets admins find and import upcoming real-world events as ready-made markets.

1. Enter a search term (e.g. a team name, tournament, or event).
2. Click **Discover**. Oro queries the event data source (currently FIFA/football fixtures).
3. Results appear as cards with event name, date, venue, and pre-filled outcomes.
4. Click **Import** on any result.
5. A **Market Form** opens pre-filled with the event details. Review and adjust, then click **Create**.

The imported market goes live immediately.

---

### Keeper Dashboard

The **Keeper** is an automated background service that handles time-sensitive operations.

The Keeper Dashboard shows:

| Panel | What it shows |
|-------|---------------|
| **Status** | Whether the Keeper is active or paused |
| **Last Run** | Timestamp of the most recent Keeper cycle |
| **Today's Stats** | Markets closed today, dispute windows opened, markets auto-settled |
| **Log Feed** | Real-time chronological log of all Keeper actions, colour-coded by type (info, success, warning, error) |

#### Manual Triggers

Admins can manually trigger individual Keeper jobs without waiting for the next scheduled cycle:

| Trigger | Action |
|---------|--------|
| **Close Markets** | Immediately closes all markets past their deadline |
| **Open Dispute Windows** | Opens dispute windows on all resolved markets |
| **Auto-Settle** | Distributes payouts on all confirmed resolved markets |

**Start / Pause** — toggle the Keeper on or off. Pausing stops automated cycles; individual triggers still work.

---

### User Management

The **User Management** page lists all registered Oro users.

#### Searching & Filtering

| Filter | Options |
|--------|---------|
| **Search** | By name or username (debounced, 400 ms) |
| **Role** | All / Admin / User |
| **DK Bank Status** | All / Linked / Unlinked |
| **Sort** | Name, Balance, Streak, Joined (asc/desc) |

Results are paginated (20 per page).

#### User Details

Each user row shows:

- Telegram username and display name
- Reputation tier
- Total predictions
- Bet streak (consecutive days)
- DK Bank link status
- Joined date
- Admin flag

Expand a user row to see full details.

#### Admin Actions

| Action | Effect |
|--------|--------|
| **Grant Admin** | Elevates the user to admin role (can log in to this portal) |
| **Revoke Admin** | Removes admin role |

> Granting admin access is an irreversible audit-logged action. Use with care.

---

### Settlement

The **Settlement** page shows the payout record for every resolved market.

Each settlement entry displays:

- Market title and winning outcome
- Total bets vs. winning bets
- Total pool vs. total paid out
- Settlement timestamp

Click the **eye icon** to open **Settlement Details**, which shows a full per-bet breakdown — who bet, how much, and what they received.

Use the **Refresh** button to reload the list after new markets resolve.

---

### Payment Logs

The **Payment Logs** page is a filterable ledger of all financial transactions on the platform.

#### Filters

| Filter | Options |
|--------|---------|
| **Status** | All / Success / Pending / Failed / Cancelled |
| **Type** | All / Deposit / Withdrawal / Bet Placed / Bet Payout / Refund |
| **Method** | All / DK Bank / TON / Credits |
| **Search** | By username or reference ID |

Each log entry shows: user, amount, method, status, and timestamp. Failed entries include a failure reason.

---

### Resolution Log

The **Resolution Log** gives a full audit trail of how every market was resolved.

Each entry shows:

- Market title and category
- Resolution status (resolved, cancelled)
- Winning outcome and whether it was proposed by a human admin or the automated system
- Dispute stats: how many objections were filed and how many were upheld
- Whether the outcome was changed from the initial proposal
- Evidence URL and note provided by the resolving admin

#### Admin Accuracy Table

At the bottom of the page, a table ranks admins by their **resolution accuracy**: the percentage of their resolutions that were not overturned by a dispute. A flagged indicator appears for admins with low accuracy or high overturn rates.

---

### Audit Log

The **Audit Log** records every admin action taken in the portal with full before/after payload.

Each entry shows:

- Timestamp
- Admin username
- Action performed (e.g. `MARKET_CREATED`, `USER_BANNED`, `MARKET_RESOLVED`)
- Entity type and ID affected
- IP address
- Priority badge: **High** (destructive/irreversible), **Medium** (financial/role changes), **Low** (reads/updates)

#### Filters

Filter by action type, category, entity type, priority, and admin. Search by entity ID or admin name.

Use the **copy** icon on any log entry to copy the full payload JSON for debugging or record-keeping.

---

### Reconciliation

The **Reconciliation** page provides a financial snapshot of the platform's accounting integrity — confirming that money in equals money out.

#### Sections

| Section | What it shows |
|---------|---------------|
| **External Flow** | Total deposits, total withdrawals, pending deposits, net external flow (deposits minus withdrawals) |
| **Settlements** | Number of settled markets, total pool handled, house earnings, payout pool, total paid out, breakage (unallocated dust) |
| **User Wallets** | Sum of all real balances and bonus balances held by users |
| **Active Bets** | Total amount currently locked in unresolved bets |
| **Reconciliation Check** | Whether the books balance: deposits in − withdrawals out − active bets − user balances − house earnings = 0 |

The snapshot timestamp shows when the data was last calculated. Click **Refresh** to re-run the reconciliation calculation against live data.

A **discrepancy** indicator highlights if the balance equation does not resolve to zero, which may indicate a data integrity issue requiring investigation.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Parimutuel** | A betting system where all stakes go into a shared pool and payouts are calculated proportionally after the event resolves. Odds are not fixed — they shift as more bets are placed. |
| **Nu (Ngultrum)** | The currency unit used in Oro, pegged to the Bhutanese Ngultrum. Displayed as "Nu" in the app. |
| **Pool** | The total amount of Nu staked on a market across all outcomes. |
| **House Edge** | The percentage of the pool retained by the platform before distributing payouts. |
| **Breakage** | Tiny rounding amounts that cannot be distributed and remain with the platform after payouts. |
| **Brier Score** | A calibration metric measuring how well-calibrated a predictor's confidence is. Used to calculate reputation tier. Lower raw score = more accurate. |
| **Reputation Tier** | User rank based on Brier score accuracy: Rookie → Sharpshooter → Hot Hand → Legend. |
| **Streak** | The number of consecutive days a user has placed at least one bet. |
| **Keeper** | The automated background service that closes markets, opens dispute windows, and settles payouts on schedule. |
| **DK Bank** | Digital Kidu Bank — Bhutan's digital payment platform used for deposits and withdrawals. |
| **CID** | Citizenship Identity number. The 11-digit ID required to link a DK Bank account. |
| **TOTP** | Time-based One-Time Password. Used for admin 2FA login. |
| **Duel** | A 1v1 challenge where two users bet on opposite outcomes of a market, with a separate wager pot. |
| **Power Card** | A one-use item that modifies duel rules (Double Down, Shield, Ghost). Earned by reaching duel win milestones. |
| **Dispute Window** | A period after an outcome is proposed during which users can file objections before the resolution is confirmed. |
| **Settlement** | The distribution of payout winnings to winning bettors after a market is confirmed resolved. |
| **Reconciliation** | A financial integrity check confirming that platform inflows equal outflows plus all balances held. |
| **Audit Log** | A tamper-evident record of every admin action taken in the portal. |
