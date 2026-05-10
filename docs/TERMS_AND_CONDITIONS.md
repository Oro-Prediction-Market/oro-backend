# Oro Prediction Market — Terms and Conditions

**Effective Date:** 1 May 2026
**Last Updated:** 1 May 2026
**Platform:** Oro Prediction Market (Telegram Mini App & Progressive Web App)
**Operator:** Oro Prediction Market
**Contact:** Available through the Oro Telegram channel at https://t.me/OroPredictionMarket

---

## 1. Acceptance of Terms

By accessing or using the Oro Prediction Market platform ("Oro", "the Platform", "we", "us"), whether through the Telegram Mini App ("TMA"), the Progressive Web App ("PWA"), or the Telegram bot (@OroPredictBot), you ("User", "you") agree to be bound by these Terms and Conditions ("Terms") in their entirety.

If you do not agree with any part of these Terms, you must immediately discontinue use of the Platform.

These Terms constitute a legally binding agreement between you and Oro. We reserve the right to update or modify these Terms at any time. Continued use of the Platform after any changes constitutes your acceptance of the revised Terms. We will notify users of material changes through the official Telegram channel.

---

## 2. Eligibility

### 2.1 Requirement

You must have **Dk Bank** to use Oro. By registering, you confirm that you are using your own DK Bank account. Oro reserves the right to request proof and to suspend or terminate any account where this requirement is not met.

### 2.2 Jurisdiction

Oro is operated for users based in **Bhutan**. Use of the Platform outside Bhutan is subject to your local laws and regulations. You are solely responsible for ensuring that your participation in prediction markets is lawful in your jurisdiction. Oro makes no representations that the Platform is appropriate or permitted in any jurisdiction outside Bhutan.

### 2.3 DK Bank Requirement

To deposit or withdraw real money, you must hold a valid **DK Bank** account and possess an 11-digit Bhutanese **Citizenship Identity Number (CID)**. Browsing markets and using welcome bonus credits does not require a DK Bank account.

### 2.4 Telegram Account

A valid **Telegram** account is required to access the Telegram Mini App version of Oro. Users may alternatively access the Web App version using a password set through Settings > Website Access, provided they have previously registered via Telegram.

### 2.5 Single Account Policy

Each user is permitted to maintain only **one account**. Creating multiple accounts to exploit bonuses, referrals, or other promotional features is prohibited and will result in permanent suspension of all associated accounts.

---

## 3. Account Registration and Security

### 3.1 Automatic Registration

Your Oro account is created automatically the first time you open the Oro Mini App within Telegram. Your Telegram display name and username are used as your identity — no separate sign-up form is required.

### 3.2 Identity Verification

When linking a DK Bank account, you are required to provide your **11-digit CID**. Oro verifies this against your DK Bank account via the DK Bank payment gateway. The CID you link must belong to you — using another person's CID is prohibited and constitutes fraud.

### 3.3 Phone Verification

Linking a DK Bank account requires that your **Telegram-registered phone number** matches the phone number registered with DK Bank. This verification is performed using a secure HMAC hash and is required before any deposit or withdrawal. Your actual phone number is never stored in plain text.

### 3.4 PWA Password

Users may set a **PWA password** (minimum 6 characters) via Settings > Website Access in the TMA. This password allows access to the web version of Oro without opening Telegram each time. It is stored as a secure one-way hash. You are responsible for keeping this password confidential.

### 3.5 Account Security

You are responsible for maintaining the security of your Telegram account and any PWA password. Oro will not be liable for any losses resulting from unauthorised access to your account. If you suspect unauthorised access, contact us immediately through the official Telegram channel.

---

## 4. Prediction Markets

### 4.1 How Markets Work

Oro uses a **parimutuel pool model**. All stakes placed on a market are pooled together. When the market resolves, the total pool (minus the platform fee) is distributed proportionally among users who bet on the winning outcome, based on their share of the total stake on that outcome.

### 4.2 Market Categories

Oro hosts prediction markets across the following categories:

- **Sports** (including football and other sporting events)
- **Weather**
- **Entertainment**
- **Economy**
- **Other**

### 4.3 Platform Fee (House Edge)

A **platform fee** is deducted from the total pool before distributing payouts to winners. The applicable fee is displayed on each market before you place a bet. The default platform fee is **10% of the total pool**. Individual markets may carry a different fee, which will always be disclosed.

### 4.4 Dynamic Odds

Odds in a parimutuel market are **not fixed**. They change in real time as more bets are placed. The payout multiplier you see when placing a bet is indicative only — your final payout depends on the total pool composition at the time the market closes. Oro does not guarantee any specific return.

### 4.5 Minimum Bet

The minimum bet per position is **Nu 50**. Bets below this amount will be rejected.

### 4.6 Market Closing

Markets close at the deadline set by the administrator. No bets can be placed after a market closes. The closing time is displayed on each market.

### 4.7 Market Resolution

Markets are resolved by the Oro administration team based on verified outcomes. The administration team **proposes** a resolution outcome — this proposal is not automatically final and may be disputed by users with an active position in the market during the objection window (see Section 7). Resolution typically occurs shortly after the real-world event concludes. Oro reserves the right to delay resolution pending verification of results.

### 4.8 Source Verification and Consensus Model

Oro does not rely on a single data source, news outlet, or sensor when determining market outcomes. Before any resolution is proposed, the administration team cross-references **multiple independent and trusted sources** — such as official governing bodies, reputable news agencies, and publicly verifiable records — to arrive at a consensus. This multi-source approach is applied consistently regardless of who proposes the outcome, including Oro's own administration team. No single report, feed, or authority is treated as conclusive on its own.

Because no source verification process is infallible, users retain the right to challenge any proposed resolution through the dispute mechanism described in Section 7.

### 4.9 Market Cancellation

Oro reserves the right to cancel a market if the underlying event is cancelled, postponed indefinitely, or if a fair resolution is not possible. In the event of cancellation, all stakes are refunded to participants in full.

---

## 5. Wallet, Deposits, and Withdrawals

### 5.1 In-App Wallet

Each Oro account has an in-app wallet balance, denominated in **Bhutanese Ngultrum (Nu / BTN)**. This balance is used exclusively within the Oro platform to place bets and receive payouts.

### 5.2 Deposits

Deposits are processed through **DK Bank** via a secure OTP-verified pull-payment flow.

| Parameter       | Value                                       |
| --------------- | ------------------------------------------- |
| Minimum deposit | **Nu 50** per transaction                   |
| Maximum deposit | **Nu 15,000** per transaction               |
| Processing      | Near-instant during DK Bank operating hours |
| Verification    | DK Bank OTP sent to your registered phone   |

To deposit, you must have a linked DK Bank account. The OTP sent by DK Bank to your registered phone must be entered in the app to authorise the transaction. Oro does not store or have access to this OTP.

### 5.3 Withdrawals

Withdrawals are processed from the Oro merchant vault to your linked DK Bank account.

| Parameter          | Value                                           |
| ------------------ | ----------------------------------------------- |
| Minimum withdrawal | **Nu 50** per transaction                       |
| Processing         | Near-instant during DK Bank operating hours     |
| Verification       | One-time password sent to your Telegram account |

Withdrawals are authorised via an OTP sent to your Telegram account. Once confirmed, funds are pushed directly to your linked DK Bank account.

### 5.4 Bonus Balance

A portion of your wallet balance may consist of **bonus credits** (marked separately). Bonus credits are subject to the following restrictions:

- Bonus credits **cannot be directly withdrawn** to your DK Bank account.
- Winnings generated from bets placed using bonus credits are capped at **Nu 50** withdrawable per bonus grant.
- Excess winnings beyond the cap are locked as bonus balance and may only be used for further betting.

### 5.5 Rate Limits

To protect the integrity of the platform, the following transaction rate limits apply:

- Deposit initiation: **5 requests per minute** per user
- Deposit OTP confirmation: **5 attempts per 15 minutes** per user
- Withdrawal initiation: **3 requests per minute** per user
- Withdrawal OTP confirmation: **5 attempts per 15 minutes** per user

Exceeding these limits will temporarily block further attempts. Repeated abuse may result in account suspension.

### 5.6 Failed Transactions

If a DK Bank transaction fails after OTP submission, no funds will be debited from your DK Bank account and no balance will be credited to your Oro wallet. You may retry by initiating a new deposit.

### 5.7 Transaction Records

All transactions are logged in your in-app transaction history. You are responsible for reviewing your transaction history and reporting any discrepancies promptly.

---

## 6. Welcome Bonus and Referral Programme

### 6.1 Welcome Bonus

All new users receive a **Nu 20 welcome bonus** upon first registration. This credit is:

- Immediately available to use for placing bets
- Marked as bonus credit (subject to the bonus withdrawal restrictions in Section 5.4)
- Non-transferable and non-refundable
- Granted once per user — duplicate accounts will not receive additional bonuses

### 6.2 Referral Programme

Users may refer new users to Oro using their unique referral link. The referral programme is structured as follows:

| Event                                     | Reward                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| Referred user makes their first bet       | **Nu 25 flat bonus** + **5% of referred user's first bet** |
| Maximum reward per referral               | **Nu 75**                                                  |
| Milestone reward (10 converted referrals) | **Nu 500 prize**                                           |

**Conditions:**

- A referral is only counted once the referred user successfully places their first bet.
- Self-referrals (using your own referral link) are automatically rejected.
- Referral bonuses are credited to the referring user's wallet.
- Oro reserves the right to modify, suspend, or terminate the referral programme at any time.
- Any attempt to abuse the referral programme (e.g. creating fake accounts, incentivised sign-ups) will result in forfeiture of all referral rewards and account suspension.

---

## 7. Dispute and Objection Process

### 7.1 Objection Window

After a market is submitted for resolution, there is a configurable **objection window** (between 10 and 120 minutes, as set per market) during which users with an active position may raise an objection if they believe the proposed resolution is incorrect.

### 7.2 Objection Bond

Filing an objection requires a **Nu 5,000 dispute bond** to be locked from your wallet balance. This bond is held while the objection is under review.

### 7.3 Objection Outcomes

| Outcome                     | Result                                     |
| --------------------------- | ------------------------------------------ |
| Objection upheld by admin   | Bond returned in full + resolution amended |
| Objection rejected by admin | Bond forfeited to the market pool          |

### 7.4 Objection Limits

- Only users with an active position in the market may file an objection.
- Only **one objection per user per market** is permitted.
- Objections can only be filed during the market's objection window.

### 7.5 Admin Decision

The Oro administration team's decision on all disputes is **final**. Oro does not enter into further correspondence regarding resolved disputes.

---

## 8. Prohibited Conduct

You agree not to engage in any of the following:

1. **Fraud and Manipulation** — Attempting to manipulate market outcomes, colluding with other users, or engaging in any form of market manipulation.
2. **Multiple Accounts** — Creating more than one account to circumvent limits, exploit bonuses, or game the referral programme.
3. **Identity Misrepresentation** — Using another person's CID, DK Bank account, or Telegram account.
4. **Automated Bots** — Using automated scripts, bots, or any non-human means to place bets or interact with the Platform (except through official Telegram bot commands as intended).
5. **Exploitation of Bugs** — Deliberately exploiting any technical error, vulnerability, or bug in the Platform. You must report any discovered bugs to Oro immediately.
6. **Money Laundering** — Using Oro in any way that constitutes or facilitates money laundering or financing of illegal activities.
7. **Chargebacks** — Initiating chargebacks or payment reversals through DK Bank after funds have been credited to your Oro wallet.
8. **Harassment** — Harassing, threatening, or abusing other users or Oro staff.
9. **Circumvention** — Attempting to circumvent any rate limit, security measure, or access control implemented by Oro.

Violations of these prohibitions may result in immediate account suspension, forfeiture of balance, and referral to relevant authorities where required by law.

---

## 9. Responsible Prediction

### 9.1 Nature of the Platform

Oro is a prediction market platform. Participation involves real financial risk. You may lose the money you deposit. Oro does not guarantee any winnings or returns.

### 9.2 Voluntary Limits

We encourage users to set personal limits on their spending. If you believe you may have a problem with gambling or compulsive betting, please seek assistance from a qualified support service before using this platform.

### 9.3 Self-Exclusion

If you wish to restrict your access to Oro, please contact us via the official Telegram channel. We will make reasonable efforts to process exclusion requests promptly.

---

## 10. Intellectual Property

All content on the Oro platform — including the name "Oro", the platform design, market structure, branding, interface, and software — is the exclusive property of Oro. You are granted a limited, non-exclusive, non-transferable licence to use the Platform for personal, non-commercial purposes.

You may not:

- Copy, reproduce, or redistribute any part of the Platform
- Reverse-engineer, decompile, or attempt to extract the source code
- Use Oro's name, brand, or imagery for commercial purposes without express written consent

---

## 11. Privacy and Data

### 11.1 Data We Collect

Oro collects and stores the following data to operate the Platform:

- Telegram user ID, display name, and username
- A hashed (one-way HMAC) representation of your phone number — your actual phone number is never stored in plain text
- Your 11-digit CID and DK Bank account number (required for payment processing)
- In-app transaction history
- Bet history and market positions
- Device and session data for security purposes

### 11.2 How We Use Your Data

Your data is used to:

- Operate your account and process transactions
- Verify your identity and prevent fraud
- Communicate with you via Telegram (OTP notifications, payout confirmations, market updates)
- Comply with applicable laws and regulations

### 11.3 Data Sharing

Oro shares data with **DK Bank** only to the extent necessary to process deposits and withdrawals. We do not sell your personal data to third parties.

### 11.4 Data Retention

Transaction records and account data are retained as required by applicable Bhutanese financial regulations. You may request deletion of non-transactional data by contacting us.

### 11.5 Security

All sensitive data is stored using industry-standard encryption. Phone numbers are stored as cryptographic hashes. Passwords are stored using bcrypt hashing. We use HMAC-SHA-256 for phone number verification.

---

## 12. Disclaimers and Limitation of Liability

### 12.1 No Guarantee of Service

Oro is provided on an **"as is" and "as available"** basis. We do not guarantee uninterrupted, error-free, or timely availability of the Platform.

### 12.2 Financial Risk

**All participation in prediction markets involves financial risk.** Oro does not guarantee any return on bets placed. You may lose some or all of the money you deposit. You acknowledge that you participate at your own risk.

### 12.3 Third-Party Services

Oro relies on third-party services including Telegram and DK Bank. We are not responsible for any downtime, errors, or failures caused by these third parties. DK Bank payment processing delays or failures are outside Oro's control.

### 12.4 Market Data

Market outcomes are determined based on publicly available information and the reasonable judgment of the Oro administration team. Oro is not responsible for inaccuracies in source data used to resolve markets.

### 12.5 Limitation of Liability

To the maximum extent permitted by applicable law, Oro's total liability to you for any claim arising out of or relating to your use of the Platform shall not exceed the **amount deposited by you in the 30 days preceding the claim**. Oro is not liable for any indirect, incidental, consequential, or punitive damages.

---

## 13. Account Suspension and Termination

### 13.1 Suspension by Oro

Oro reserves the right to suspend or permanently terminate any account at its sole discretion, including but not limited to cases of:

- Violation of these Terms
- Suspected fraud or identity misrepresentation
- Suspected money laundering or illegal activity
- Abuse of bonuses, referrals, or promotions
- Chargebacks or disputed DK Bank transactions

### 13.2 Effect of Termination

Upon termination, any **real money balance** (non-bonus funds) remaining in your wallet will be returned to your linked DK Bank account within a reasonable period, subject to verification. Bonus credits are forfeited upon termination.

### 13.3 Termination by User

You may request account closure at any time by contacting us via the official Telegram channel. Pending bets will be settled before closure is processed.

---

## 14. Modifications to the Platform

Oro reserves the right to modify, suspend, or discontinue any feature of the Platform at any time without notice. This includes market types, fee structures, bonus programmes, and payment limits. We will endeavour to communicate significant changes through the official Telegram channel in advance where possible.

---

## 15. Governing Law and Jurisdiction

These Terms are governed by and construed in accordance with the laws of the **Kingdom of Bhutan**. Any dispute arising out of or in connection with these Terms shall be subject to the exclusive jurisdiction of the competent courts of Bhutan.

---

## 16. Severability

If any provision of these Terms is found to be unenforceable or invalid under applicable law, that provision will be limited or eliminated to the minimum extent necessary, and the remaining provisions will continue in full force and effect.

---

## 17. Entire Agreement

These Terms, together with any additional policies or rules posted on the Platform, constitute the entire agreement between you and Oro with respect to your use of the Platform, and supersede all prior agreements and understandings.

---

## 18. Contact

For questions, disputes, or support requests, please contact us through:

- **Telegram Channel:** https://t.me/OroPredictionMarket
- **Telegram Bot:** @OroPredictBot

---

_By using Oro, you confirm that you have read, understood, and agreed to these Terms and Conditions in their entirety._

---

**© 2026 Oro Prediction Market. All rights reserved.**
