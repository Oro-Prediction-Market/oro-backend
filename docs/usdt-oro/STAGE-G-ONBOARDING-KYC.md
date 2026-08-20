# Stage G: Email Signup, Document KYC, Admin Review

**Touches BTN:** No. New auth provider, new table, new columns.
**User-visible:** No until Stage I.
**Depends on:** Nothing. Runs fully in parallel with 0 through F.

## Goal

A signup path for international users: email credential, document upload,
manual review, USDT account on approval.

## G.1 Password auth already exists

The source plan treats password auth as the genuinely new piece, because
LuckyPemX had none. **Oro already has it.**

- `users.pwaPasswordHash` — bcryptjs, self-chosen, set from the TMA settings
  page for PWA login ([user.entity.ts:256](../../src/entities/user.entity.ts#L256))
- `users.email` — already nullable on `users`
- `bcrypt` and `bcryptjs` both in `package.json`
- Password verification live at
  [`auth.service.ts:847`](../../src/auth/auth.service.ts#L847), set/check at
  [449-460](../../src/auth/auth.service.ts#L449)

So this stage is materially smaller than the source plan implies. What is
missing is not the credential — it is **email as an identity**, email
verification, password reset, and KYC.

| Piece | Status |
|---|---|
| Password hashing and verification | Exists |
| Email column | Exists |
| Email as an auth provider | New |
| Email verification before KYC | New |
| Password reset by emailed token | New |
| KYC documents and review | New |
| `users.currency`, `users.kycStatus` | New (currency lands in Stage B) |

Note that `pwaPasswordHash` today is a **secondary** credential — a convenience
for users who already authenticated via Telegram or DK Bank. For an email
account it becomes the **primary and only** credential. That changes its threat
model: it is now a credential-stuffing target and an account-recovery
single point of failure. Rate-limit login, registration, and reset; Oro's
global throttler at 120/min is nowhere near tight enough for these three.

## G.2 Email as an auth provider

Add `AuthProvider.EMAIL` to
[`auth-method.entity.ts:12`](../../src/entities/auth-method.entity.ts#L12).

`auth_methods` is already `@Index(["provider", "providerId"], { unique: true })`,
so setting `providerId` to the normalized (lowercased, trimmed) email gives
one-account-per-email for free, with no new constraint. Normalize on write, not
on read; a single un-normalized insert defeats the uniqueness.

**Migration:** Postgres `ALTER TYPE "auth_methods_provider_enum" ADD VALUE`.
Cannot be removed later, so agree the spelling first.

`auth.service.ts` already branches per provider across `loginWithTelegram`,
`loginWithDKBank`, and `loginWithBhutanApp`. Add `loginWithEmail` beside them
and **leave the other three byte-identical.** They serve every current user.

## G.3 KYC documents

Separate table. Identity is who you authenticate as; KYC is proof of who you
are. Conflating them means a resubmitted document touches the auth path.

**`user_kyc_documents`**

```
id              uuid, pk
userId          varchar(36), indexed
documentType    enum (PASSPORT, NATIONAL_ID, DRIVERS_LICENSE)
documentNumber  varchar(64)      encrypted at rest
documentCountry varchar(2)
imageObjectKey  varchar(255)     storage reference, never the image itself
status          enum (PENDING, APPROVED, REJECTED)
reviewedBy      varchar(36), null
reviewedAt      timestamptz, null
rejectionReason varchar(255), null
submittedAt     timestamptz
```

Plus `users.kycStatus`, denormalised so the deposit check does not join.

Oro's existing `users.dkCid` is Bhutan-specific and stays that way — a CID is
not a document type on this path.

**Storage.** Document images are sensitive PII, and these users are in
jurisdictions with erasure rights. Master-plan decision 6, and it needs an
owner before this ships:

- Private object storage. Never the application database, never a public bucket.
- Encrypted at rest; column encryption for `documentNumber`.
- Signed, short-lived URLs for reviewer access. No permanent links.
- Access written to `audit_logs` — who viewed which document, when. Oro has
  [`audit-log.entity.ts`](../../src/entities/audit-log.entity.ts) already.
- A defined retention period and a deletion path.

**Never log document numbers or image keys.** Add them to
[`redact.util.ts`](../../src/shared/utils/redact.util.ts) rather than relying on
each call site.

## G.4 Signup flow

```
1. POST /auth/email/register     email + password → verification email
2. GET  /auth/email/verify       token → email confirmed
3. POST /auth/email/kyc          document type, number, country, image
                                 → creates user, currency='USDT',
                                   kycStatus=PENDING
4. Admin reviews
5. APPROVED → deposit unlocked
```

**An unverified email must not reach document upload.** Otherwise the review
queue fills with documents belonging to addresses nobody controls.

At step 3 the user is created with **`currency = 'USDT'`**, set once and never
changed. There is no code path that updates `users.currency`, and the absence of
one is the segregation guarantee.

The account can log in and browse markets immediately. It cannot deposit.

## G.5 The gate is on deposit

An account with `kycStatus != APPROVED` cannot create a deposit intent —
enforced in [Stage C.2](./STAGE-C-INTENTS.md#c2-create-intent), guard 2.

**Not on withdrawal.** Blocking withdrawal instead means accepting money from
someone we may then refuse to pay, which is the worst position to be in both
legally and reputationally. Blocking deposit means a rejected applicant simply
never funded an account, and nothing is in limbo.

## G.6 Admin review queue

In `oro-admin`:

- Queue of `PENDING` documents, oldest first, image behind a signed URL.
- Approve → `users.kycStatus = APPROVED`, deposit unlocked.
- Reject with a reason → user notified, one resubmission allowed.
- Every action to `audit_logs` with the reviewer id.
- **Reviewer permission as its own role.** Not everyone with admin access
  should see passport images.

Master-plan decision 5 covers who staffs this and at what SLA. Manual review is
fine at low volume and becomes the bottleneck on the growth path, so instrument
queue depth and oldest-pending age from day one rather than discovering it
later.

## G.7 One human, two accounts

Someone may hold a Bhutanese BTN account and an email USDT account. They are
separate users with separate balances and no link. This is accepted.

Two consequences worth recording:

- Any per-user limit is doubled for that person. Oro's limits are per-user, so
  this is a widening of exposure, not a bug — but the AML module should know.
- If the two are ever linked — the same document number appearing under both —
  that is a signal worth surfacing to compliance rather than acting on
  automatically.

Oro has an `aml/` module already; route the second point through it rather than
building a parallel detector.

## Verification

- Unit: register, verify, login, reset — each rate-limited at a tier
  appropriate to a primary credential, not the global 120/min.
- Unit: unverified email cannot reach document upload.
- Unit: duplicate email rejected by the existing `(provider, providerId)`
  uniqueness, including a differently-cased duplicate.
- Unit: email signup creates a user with `currency = 'USDT'` and
  `kycStatus = PENDING`.
- Unit: **no code path updates `users.currency`.** Assert by absence — a source
  scan, like the ledger guard.
- Unit: `PENDING` cannot create a deposit intent; `APPROVED` can.
- Unit: a rejected account can resubmit once.
- **Integration: Telegram, DK Bank, and BhutanApp login flows unchanged end to
  end.** This is the regression risk in this stage, and it is the only one that
  matters — those paths serve every current user.
- Security: document images unreachable without a signed URL; access appears in
  `audit_logs`; document numbers absent from all logs.

## Rollback

Additive: one enum value, new nullable columns, one new table, new routes.
Existing auth paths untouched. Revert and drop — noting that the Postgres enum
value cannot be removed.
</content>
