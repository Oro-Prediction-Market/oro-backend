import { BadRequestException } from "@nestjs/common";
import { DataSource, EntityManager, Repository } from "typeorm";
import {
  BTN_CURRENCY,
  Transaction,
} from "../../entities/transaction.entity";
import { User } from "../../entities/user.entity";

export type LedgerSource =
  | EntityManager
  | DataSource
  | Repository<Transaction>;

/** EntityManager is its own manager; DataSource and Repository each hold one. */
function resolveManager(src: LedgerSource): EntityManager {
  return (src as any).manager ?? (src as EntityManager);
}

function txBuilder(src: LedgerSource) {
  const anySrc = src as any;
  return typeof anySrc.getRepository === "function"
    ? anySrc.getRepository(Transaction).createQueryBuilder("t")
    : (src as Repository<Transaction>).createQueryBuilder("t");
}

export async function ledgerBalance(
  em: LedgerSource,
  userId: string,
  currency: string,
): Promise<number> {
  const { balance } = await txBuilder(em)
    .select("COALESCE(SUM(t.amount), 0)", "balance")
    .where("t.userId = :userId AND t.currency = :currency", {
      userId,
      currency,
    })
    .getRawOne();
  return Number(balance);
}


export async function ledgerBalanceForAccount(
  em: LedgerSource,
  userId: string,
): Promise<number> {
  const { balance } = await txBuilder(em)
    .select("COALESCE(SUM(t.amount), 0)", "balance")
    .where(
      "t.userId = :userId AND t.currency = " +
        "(SELECT u.currency FROM users u WHERE u.id = :userId)",
      { userId },
    )
    .getRawOne();
  return Number(balance);
}

/**
 * Bulk form of {@link ledgerBalanceForAccount}, one query for many users.
 *
 * Settlement loads balances for every participant in a market — up to 1,000 at
 * a time — and must not regress to a query per user. Users with no ledger rows
 * are absent from the map; callers already treat a missing entry as 0.
 */
/**
 * Balances for many accounts, per currency, keyed `${userId}|${currency}`.
 *
 * {@link ledgerBalancesForAccounts} scopes to each account's **native**
 * currency, which is wrong wherever the row being written is in the currency
 * of a *book* rather than of the account. A Bhutanese user who staked USDT and
 * won had their payout row stamped with a `balanceBefore` taken from their
 * ngultrum balance — the amount was right, so derived balances stayed correct,
 * but the row described a balance in a currency it was not in, and that is the
 * number the transaction history prints back to the user.
 *
 * Grouped by both dimensions in one query, because a single market can settle
 * or refund positions in more than one currency at once.
 */
export async function ledgerBalancesByAccountCurrency(
  em: LedgerSource,
  userIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;

  const rows: { userId: string; currency: string; balance: string }[] =
    await txBuilder(em)
      .select("t.userId", "userId")
      .addSelect("t.currency", "currency")
      .addSelect("COALESCE(SUM(t.amount), 0)", "balance")
      .where("t.userId IN (:...ids)", { ids: userIds })
      // Both columns in one `groupBy` rather than `groupBy().addGroupBy()`:
      // the engine's tests hand-roll query-builder stubs, and every extra
      // method used here is one more they have to know about. Same reason the
      // helpers above avoid joins.
      .groupBy("t.userId, t.currency")
      .getRawMany();

  for (const r of rows) {
    out.set(balanceKey(r.userId, r.currency), Number(r.balance));
  }
  return out;
}

/** The key shape used by {@link ledgerBalancesByAccountCurrency}. */
export function balanceKey(userId: string, currency: string): string {
  return `${userId}|${currency}`;
}

export async function ledgerBalancesForAccounts(
  em: LedgerSource,
  userIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;

  const rows: { userId: string; balance: string }[] = await txBuilder(em)
    .select("t.userId", "userId")
    .addSelect("COALESCE(SUM(t.amount), 0)", "balance")
    .where(
      "t.userId IN (:...ids) AND t.currency = " +
        '(SELECT u.currency FROM users u WHERE u.id = t."userId")',
      { ids: userIds },
    )
    .groupBy("t.userId")
    .getRawMany();

  for (const r of rows) out.set(r.userId, Number(r.balance));
  return out;
}


export async function accountCurrency(
  em: LedgerSource,
  userId: string,
): Promise<string> {
  const row = await resolveManager(em)
    .getRepository(User)
    .createQueryBuilder("u")
    .select("u.currency", "currency")
    .where("u.id = :userId", { userId })
    .getRawOne<{ currency: string }>();
  return row?.currency ?? BTN_CURRENCY;
}


export async function assertSameCurrency(
  em: LedgerSource,
  fromUserId: string,
  toUserId: string,
): Promise<string> {
  const [from, to] = await Promise.all([
    accountCurrency(em, fromUserId),
    accountCurrency(em, toUserId),
  ]);
  if (from !== to) {
    throw new BadRequestException(
      `Cannot move balance between accounts of different currencies (${from} → ${to}).`,
    );
  }
  return from;
}
