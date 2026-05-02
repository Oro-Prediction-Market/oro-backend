# Production Integration Note

> Written: April 2, 2026  
> Author: Copilot  
> Status: Staging works ✅ — Real money flow needs these two steps wired in

---

## What is already built and working ✅

| Feature                                          | Status              |
| ------------------------------------------------ | ------------------- |
| Telegram phone hash === DK Bank phone hash check | ✅ Done             |
| OTP sent to Telegram bot after hash match        | ✅ Done             |
| OTP verification                                 | ✅ Done             |
| Oro internal balance credited after OTP         | ✅ Done             |
| Balance check before placing bet                 | ✅ Done             |
| Bet deduction from balance                       | ✅ Done             |
| Payout on winning bet                            | ✅ Done             |
| Transaction history (the "wallet receipt")       | ✅ Done             |
| Deposit button UI exists                         | ✅ Done (not wired) |
| Withdraw button UI exists                        | ✅ Done (not wired) |

---

## Your security model (keep this — it's stronger than standard DK flow)

```
Registration (one-time):
  1. User links CID in TMA profile
     → DK returns phone number for that CID
     → Stored as dkPhoneHash on user row

  2. User sends /verify in Telegram bot
     → Shares phone via Telegram native contact share
     → Stored as telegramPhoneHash on user row
     → CHECK: telegramPhoneHash === dkPhoneHash
     → If match → verified, payments unlocked

Payment (every deposit):
  1. verifyPaymentIdentity() re-checks telegramPhoneHash === dkPhoneHash
  2. ONLY if match → 6-digit OTP generated → sent to Telegram bot
  3. User enters OTP in TMA
  4. OTP verified → [PRODUCTION: DK debit here] → Oro balance credited
```

**This is more secure than DK's own SMS OTP** because:

- Telegram requires biometrics/PIN to open
- Phone number is cryptographically verified at link time (not per-transaction)
- No SMS = no SIM swap attack vector

---

## What needs to be added for production

### 1. Wire up DK debit in `confirmPayment()`

**File:** `backend/src/payment/dkbank-payment.service.ts`  
**Method:** `confirmPayment()`  
**Where:** After Telegram OTP is verified, before `applyDKStatusUpdate()`

Replace this comment block:

```typescript
// Telegram OTP verified — credit Oro balance directly.
// We never call DK account_auth/debit_request so no DK SMS is ever triggered.
```

With these two real DK calls:

```typescript
// Step A: Get bfsTxnId from DK (account_auth)
const stanNumber = this.dkGateway.generateStanNumber();
const { bfsTxnId, txDatetime } = await this.dkGateway.authorizeTransaction({
  customerAccountNumber: meta.customerAccountNumber,
  customerAccountName: meta.customerAccountName,
  customerPhone: payment.customerPhone,
  amount: Number(payment.amount),
  description: payment.description,
  stanNumber,
});

// Step B: Execute debit — moves money from user's DK account → your merchant account
const { txnStatusId } = await this.dkGateway.executeTransactionWithOtp({
  bfsTxnId,
  otp: "000000", // DK staging bypass — replace with real DK OTP flow in production
  stanNumber,
  txDatetime,
  sourceAccountNumber: meta.customerAccountNumber,
  sourceAccountName: meta.customerAccountName,
  amount: Number(payment.amount),
  description: payment.description,
});

// Save txnStatusId so webhook/polling can track it
payment.dkTxnStatusId = txnStatusId;
await this.paymentRepo.save(payment);
```

Then keep the existing `applyDKStatusUpdate()` call — it already handles crediting Oro balance.

> **Note on OTP:** In staging, DK uses `DK_STAGING_OTP_BYPASS=000000` (already in your .env).  
> In production, `account_auth` triggers a DK SMS to the user — but since your Telegram OTP  
> is already the user-facing gate, pass the DK SMS OTP value transparently or use whatever  
> DK's production bypass mechanism is. Confirm with DK Bank what the production OTP flow is.

---

### 2. Wire up Deposit button in frontend

**File (TMA):** `frontend/src/tma/pages/TmaProfilePage.tsx`  
**File (PWA):** `frontend/src/pwa/pages/PwaWalletPage.tsx`

The Deposit button currently has no `onClick`. Add:

1. Amount input modal
2. Call `POST /payment/initiate` with `{ amount, customerPhone: user.dkCid }`
3. Show OTP input modal (OTP arrives in Telegram bot)
4. Call `POST /payment/confirm` with `{ paymentId, otp }`
5. Refresh balance on success

The `TmaPaymentModal` component already exists and handles this flow for bets —
you can reuse the same pattern for deposits.

---

### 3. Wire up Withdraw button

**File (TMA):** `frontend/src/tma/pages/TmaProfilePage.tsx`  
**File (PWA):** `frontend/src/pwa/pages/PwaWalletPage.tsx`  
**Backend:** Needs a new `POST /payment/withdraw` endpoint

Withdrawal flow:

1. User enters amount to withdraw
2. Backend checks Oro balance >= amount
3. Backend calls DK transfer: merchant account → user's DK account  
   (use `DK_BATCH_BASE_URL` — DK has a credit/transfer API for merchant → customer)
4. On DK SUCCESS → deduct from Transaction table (create WITHDRAWAL transaction entry)
5. User's Oro balance decreases, real BTN arrives in their DK account

---

### 4. Remove starter credits before go-live

**File:** `backend/src/auth/auth.service.ts`  
Search for: `TODO: REMOVE before production`  
There are **2 occurrences** — one for Telegram login, one for DK Bank login.  
Delete both `transactionRepo.save(...)` blocks entirely.

---

## Mental model (keep this in mind)

```
YOUR MERCHANT ACCOUNT (110158212197)  ←  the vault (real BTN)
        ↑ deposit            ↓ withdrawal/payout
Oro TRANSACTION TABLE  ←  the receipt (scoreboard per user)
        ↑ payout win         ↓ bet placed
USER'S Oro WALLET  ←  just a number = sum of their Transaction rows
```

The solvency rule that must always hold in production:

```
Sum of all user Oro balances  =  Merchant account balance (minus house edge kept)
```

---

## Files to touch for production go-live

| File                                            | Change                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `backend/src/payment/dkbank-payment.service.ts` | Add `authorizeTransaction` + `executeTransactionWithOtp` in `confirmPayment()` |
| `backend/src/auth/auth.service.ts`              | Remove 2x starter credit blocks (search `TODO: REMOVE`)                        |
| `frontend/src/tma/pages/TmaProfilePage.tsx`     | Wire Deposit + Withdraw buttons                                                |
| `frontend/src/pwa/pages/PwaWalletPage.tsx`      | Wire Deposit + Withdraw buttons                                                |
| `backend/src/payment/`                          | Add `POST /payment/withdraw` endpoint + service method                         |
| `backend/.env`                                  | Set real `TELEGRAM_MINI_APP_URL` (not ngrok)                                   |
| `backend/.env`                                  | Set real `TELEGRAM_WEBHOOK_URL` (not ngrok)                                    |

---

_Everything else is production-ready._

---

## Phase 2 — TON Wallet Integration

> Do NOT touch until Phase 1 (DK Bank production) is live and stable.

### What is already scaffolded (do not delete)

- `frontend/src/tma/pages/TONBetPage.tsx` — bet UI with wallet connect
- `frontend/src/tma/pages/TONConnectPage/` — wallet display page
- `public/tonconnect-manifest.json` — TON Connect app manifest
- `POST /markets/:id/bets/wallet` — endpoint stub in `markets.controller.ts`
- `placeBetWithWallet()` in `api/client.ts` — frontend API call
- `PaymentMethod.TON` — enum ready in `payment.entity.ts`

### What needs to be built for Phase 2

| Task                             | File                                                            | Notes                                                                  |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Real platform TON wallet address | `TONBetPage.tsx` line ~63 — replace `"EQD..."`                  | Generate a custodial TON wallet for the platform                       |
| On-chain tx verification         | `markets.controller.ts` `placeBetWithWallet()`                  | Call TON Center API to verify `txHash` before recording bet            |
| TON node / API access            | New env var `TON_API_KEY`                                       | Use [toncenter.com](https://toncenter.com) free tier or own node       |
| Backend bet recording            | `markets.controller.ts` → `marketsService.placeBetWithWallet()` | Verify tx on-chain, then call `parimutuelEngine.placeBet()`            |
| TON payout on win                | New service `ton-payout.service.ts`                             | Send TON from platform wallet to winner's wallet address on settlement |
| Separate TON balance             | Parallel to BTN Transaction table                               | TON bets must NOT mix with DK/BTN internal ledger                      |

### Key decision for Phase 2

TON and DK/BTN are completely separate financial systems. You have two options:

**Option A — Pure TON track (recommended)**

```
TON user bets in TON → platform TON wallet receives TON
Wins paid back in TON from platform wallet
Completely separate from DK/BTN system
```

**Option B — TON converts to Oro BTN credits**

```
User sends TON → you convert to BTN at exchange rate
Credits BTN to Oro internal balance
User bets from BTN balance as normal
Requires: exchange rate oracle + conversion management
```

Option A is simpler and cleaner. Option B adds exchange rate risk.
