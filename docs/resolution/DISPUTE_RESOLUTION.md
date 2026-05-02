# Dispute Resolution — Centralized with Transparency

## What We Chose

**Admin Final Call with Dispute Bonds**

When a market closes, the admin proposes a winning outcome and a 24-hour dispute window opens. Any bettor can stake a bond to signal disagreement. After reviewing disputes, the admin makes the final resolution call.

## Flow

```
CLOSED → RESOLVING (admin proposes outcome, 24h window opens)
         ↓
         Bettors submit dispute bonds (optional)
         ↓
RESOLVING → RESOLVED → SETTLED (admin makes final call, bonds refunded)
```

## Why Centralized

### Why not Polymarket-style decentralized oracle?

Polymarket uses UMA protocol — a decentralized oracle where token holders vote on disputed outcomes. This requires:
- An on-chain governance token
- Economic incentives for oracle voters
- On-chain smart contracts for bond escrow and voting
- A large enough community to avoid manipulation

We are not at that stage. Building a trustless oracle before we have volume or users would be premature and expensive to maintain.

### Why this is still fair

**1. Full audit trail**
Every dispute bond, admin action, and settlement is recorded in the ledger with timestamps. If a user believes they were treated unfairly, the full history is available for review.

**2. Bonds as commitment signals**
The bond requirement prevents spam disputes. If a bettor stakes real credits to dispute, the admin can see who disputes seriously and how much they've committed.

**3. Bonds always refunded**
To keep it simple and trust-building, all dispute bonds are refunded after the admin makes the final call — regardless of whether the outcome changes. The bond's only purpose is to signal seriousness, not to punish or reward disputers.

**4. Admin accountability**
The admin is accountable through transparency. Any resolution decision is logged and can be audited. Patterns of unfair resolution would be visible to users over time.

## Why This is the Right Choice for Now

- **Simpler UX** — No wallet, no gas, no token. Users just stake credits.
- **Faster to build and ship** — One entity, one endpoint, one UI panel.
- **Accessible to our audience** — Telegram/mobile users are not expecting trustless governance.
- **Upgrade path** — Once we have volume and community, we can layer in an oracle or community voting round on top of this same flow.

## What We Are NOT Doing (and why)

| Feature | Why deferred |
|---|---|
| Oracle / UMA protocol | Requires on-chain governance + community |
| Bond forfeiture (loser pays) | Adds complex payout edge cases |
| Community vote round | Needs sufficient active user base |
| Automatic resolution | Requires trusted external data source (API/oracle) |

## Future Upgrade Path

When the platform matures:
1. Add a community vote round as a middle step between dispute threshold and admin override
2. Introduce an on-chain oracle for markets with verifiable outcomes (sports scores, prices)
3. Move bond escrow on-chain for trustless settlement

For now, the admin is the oracle. The audit trail is the accountability.
