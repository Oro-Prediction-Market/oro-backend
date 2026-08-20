# Staging runbook — C3 and C7

Production migrations in this repo are hand-applied: the SQL runs manually and
a `migrations` row is inserted so TypeORM does not re-run it. Staging is the
rehearsal for that, and it must be done there first.

Both migrations below were verified end to end against a Postgres 16 built from
this repo's full migration chain, with pre-existing market and ledger data
present: applied, inspected, reverted, re-applied, and re-run to confirm the
backfills are idempotent.

## Order

`1775990000330` (ledger currency) then `1775990000340` (market books). The
second does not depend on the first, but keep the order so the `migrations`
table matches the file order.

## Before you start

```sql
-- Record these. Every one must be unchanged afterwards.
SELECT COALESCE(SUM(amount), 0)          AS tx_sum        FROM transactions;
SELECT COUNT(*)                          AS tx_count      FROM transactions;
SELECT COALESCE(SUM("totalPool"), 0)     AS market_pool   FROM markets;
SELECT COALESCE(SUM("totalBetAmount"),0) AS outcome_stake FROM outcomes;
SELECT COUNT(*) AS markets FROM markets;
SELECT COUNT(*) AS outcomes FROM outcomes;
```

Take a backup first. `1775990000340` narrows `numeric(28,9)` back to
`numeric(18,2)` on rollback, which is lossless **only** while no USDT book
exists — true throughout staging, but the habit matters.

## Running it

Prefer the CLI on staging, since it writes the `migrations` rows for you:

```bash
npm run migration:run     # applies 330 and 340, records both
```

Use the raw SQL below only where the CLI cannot reach the database. If you do,
you must insert the `migrations` rows yourself — the statements are at the end.

## Checks after applying

```sql
-- 1. Nothing moved.
SELECT COALESCE(SUM(amount), 0) FROM transactions;          -- = tx_sum
SELECT COUNT(*) FROM transactions;                          -- = tx_count

-- 2. Ledger currency backfilled, no strays.
SELECT currency, COUNT(*) FROM transactions GROUP BY currency;   -- BTN only
SELECT currency, COUNT(*) FROM users        GROUP BY currency;   -- BTN only

-- 3. One BTN book per market and per outcome, values carried across.
SELECT (SELECT COUNT(*) FROM markets)  = (SELECT COUNT(*) FROM market_books)  AS market_parity;
SELECT (SELECT COUNT(*) FROM outcomes) = (SELECT COUNT(*) FROM outcome_books) AS outcome_parity;
SELECT COALESCE(SUM("totalPool"), 0) FROM market_books;      -- = market_pool
SELECT COALESCE(SUM("totalBetAmount"), 0) FROM outcome_books; -- = outcome_stake

-- 4. Edges preserved exactly, not flattened to the 10% default.
SELECT COUNT(*) AS edge_mismatches
FROM market_books mb JOIN markets m ON m.id = mb."marketId"
WHERE mb."houseEdgePct" <> m."houseEdgePct";                 -- 0

-- 5. minStake follows the engine rule: TER/BTC = 10, everything else = 50.
SELECT m."externalSource", mb."minStake", COUNT(*)
FROM market_books mb JOIN markets m ON m.id = mb."marketId"
GROUP BY 1, 2 ORDER BY 1;

-- 6. Precision widened where the column exists.
SELECT table_name, column_name, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE numeric_precision = 28 AND numeric_scale = 9
ORDER BY 1, 2;

-- 7. No cross-currency rows anywhere yet.
SELECT COUNT(*) FROM transactions t JOIN users u ON u.id = t."userId"
WHERE t.currency <> u.currency;                              -- 0
```

Then boot the app against staging and confirm the balance sheet, revenue
reporting and reconciliation return the same BTN numbers as before.

## Known drift you will meet

Two entity/database mismatches predate this work and are **not** fixed by these
migrations:

- **`disputes.rewardAmount`** was on the entity with no migration creating it,
  so a database built from migrations did not have the column and every dispute
  query failed. `1775990000360-AddDisputeRewardAmount` now creates it at
  `numeric(28,9)` if missing; `1775990000340` still widens money columns only
  where they exist, so either ordering works.
- **`season_prize`** is in `TransactionType` and written by
  `season.service.ts`, but is missing from `transactions_type_enum` in a
  migration-built database. If it is missing in production, season prizes have
  never written successfully. Worth checking directly:

```sql
SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'transactions_type_enum' ORDER BY enumsortorder;
```

## Do not set DB_SYNCHRONIZE=true

Against a correctly migrated database, TypeORM's synchronize wants to run ~226
statements and **drop 55 existing indexes** — migration-created indexes that no
entity declares. It also aborts partway on a `markets_category_enum_old`
dependency. Every index these two migrations create is declared on its entity,
so none of them is at risk, but the flag remains unsafe here generally.

## Rollback

```bash
npm run migration:revert   # reverts 340
npm run migration:revert   # reverts 330
```

Verified clean: both drop their tables, columns and indexes, narrow the money
columns back, and leave source data untouched. Safe while no USDT book exists.

## `migrations` rows, if applying SQL by hand

```sql
INSERT INTO migrations ("timestamp", name)
VALUES (1775990000330, 'AddLedgerCurrency1775990000330');

INSERT INTO migrations ("timestamp", name)
VALUES (1775990000340, 'AddMarketBooks1775990000340');
```
