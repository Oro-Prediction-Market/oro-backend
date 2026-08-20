import * as fs from "node:fs";
import {
  balanceKey,
  ledgerBalancesByAccountCurrency,
} from "../shared/utils/ledger.util";
import * as path from "node:path";

/**
 * Static guard: every SUM over `transactions.amount` must be currency-scoped.
 *
 * Balances in Oro are derived — there is no balance column, only
 * `SUM(amount) WHERE "userId" = ?`. An unfiltered sum therefore folds the USDT
 * book into the BTN book: a crypto deposit becomes spendable ngultrum and is
 * withdrawable through DK Bank. That is a mint-money bug, not a display bug,
 * and it is invisible until the first USDT row exists — which means staging
 * will not catch it unless staging has USDT rows.
 *
 * This is deliberately a source scan rather than a behavioural test. The
 * failure mode it exists for is "someone adds a 35th balance query in six
 * months", which no unit test of today's code can cover.
 *
 * See docs/usdt-oro/STAGE-B-LEDGER-SEGREGATION.md.
 */
const SRC = path.join(__dirname, "..");

const SKIP_DIRS = new Set(["__tests__", "migrations", "node_modules"]);

/**
 * Files whose `amount` sums are not ledger balance reads.
 *
 * Every entry needs a justification. An entry added to make the suite pass is
 * a defect being hidden, not a false positive being suppressed.
 */
const SKIP_FILES = new Map<string, string>([
  // Column definition, not a query.
  ["transaction.entity.ts", "entity definition — declares the column"],
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), acc);
    } else if (entry.name.endsWith(".ts") && !SKIP_FILES.has(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

/**
 * Two shapes of ledger sum, kept as separate patterns because one regex that
 * covers both is unreadable and — as an earlier attempt here proved — quietly
 * wrong. A single pattern using `(?:[^()]|\([^()]*\))*?` swallows a nested
 * paren group whole, so `SUM(ABS(amount::numeric))` stopped matching while
 * looking like it had been broadened.
 *
 * DIRECT covers, all present in this codebase:
 *   SUM(amount)                     SUM(t.amount)
 *   SUM("amount")                   SUM(ABS(bt.amount))
 *   SUM(amount::numeric)            SUM(ABS(w.amount::numeric))
 *
 * CONDITIONAL covers the aggregate-with-CASE form, which carries the
 * promotional-credit totals on the admin dashboard:
 *   SUM(CASE WHEN t.type = 'free_credit' THEN t.amount ELSE 0 END)
 *   SUM(CASE WHEN type IN ('referral_bonus','referral_prize') THEN amount END)
 *
 * The bounded `{0,200}` keeps the CASE pattern from running away across lines.
 */
const SUM_DIRECT = /SUM\(\s*(?:ABS\(\s*)?(?:[a-z0-9_"]+\.)?"?amount"?\b/i;
const SUM_CONDITIONAL = /SUM\(\s*CASE\b[\s\S]{0,200}?\bamount\b/i;
const matchesSum = (line: string) =>
  SUM_DIRECT.test(line) || SUM_CONDITIONAL.test(line);

/**
 * Aliases belonging to other tables that also have an `amount` column.
 * `positions.amount` is a stake, not a ledger row, and carries its currency
 * via its book rather than its own column.
 *
 * Alias-based discrimination is the weakest part of this guard: it depends on
 * naming convention, so a query that aliases positions as something else will
 * be scanned as if it were the ledger. That direction fails loudly (a false
 * offender someone has to look at) rather than silently, which is the right
 * way round.
 */
const NON_LEDGER_ALIASES = /SUM\(\s*(?:ABS\(\s*)?(pos|p|position)\./i;

/** Does this window actually read the transactions table? */
const READS_LEDGER =
  /getRepository\(Transaction\)|transactionRepo|txRepo|(?:FROM|JOIN)\s+"?transactions"?|createQueryBuilder\("t"\)/i;

/**
 * Does this window constrain currency?
 *
 * Requires `currency` in a position that looks like a predicate, a bound
 * parameter, or an argument — not merely the word appearing somewhere nearby.
 * A comment mentioning currency must not be enough to pass the guard.
 */
const SCOPES_CURRENCY =
  /"?currency"?\s*(=|IN\b)|currency\s*:|:currency\b|\bcurrency\s*[,)]|BTN_CURRENCY/i;

/**
 * Grouping by currency also scopes — arguably more strongly than a predicate,
 * since a GROUP BY can never merge two currencies into one total. A report
 * that returns a row per currency is correct without naming one.
 */
const GROUPS_BY_CURRENCY =
  /(?:addGroupBy|groupBy)\(\s*["'`][^"'`]*currency|GROUP\s+BY[^;]*\bcurrency\b/i;

describe("ledger sums are currency-scoped", () => {
  const offenders: string[] = [];

  beforeAll(() => {
    for (const file of walk(SRC)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!matchesSum(line)) return;
        if (NON_LEDGER_ALIASES.test(line)) return;

        const window = lines.slice(Math.max(0, i - 8), i + 14).join("\n");
        if (!READS_LEDGER.test(window)) return;
        if (SCOPES_CURRENCY.test(window)) return;
        if (GROUPS_BY_CURRENCY.test(window)) return;

        offenders.push(
          `${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 90)}`,
        );
      });
    }
  });

  it("has no unfiltered SUM(amount) over the transactions table", () => {
    expect(offenders).toEqual([]);
  });
});

/**
 * The guard above is a pile of regexes, and C4 is going to be judged green or
 * red by it. These check the regexes themselves — that they catch every shape
 * of ledger sum in this codebase, and, just as importantly, that a properly
 * scoped query is actually recognised as scoped. Without the second half the
 * suite could only ever prove "still broken" and never "genuinely fixed".
 */
describe("guard self-check", () => {
  it("matches every SUM shape present in the codebase", () => {
    const shapes = [
      'SELECT COALESCE(SUM(amount), 0)::float AS total',
      '.select("COALESCE(SUM(t.amount), 0)", "balance")',
      'SELECT SUM(pt.amount)',
      'SELECT COALESCE(SUM(ABS(bt.amount)), 0)::float AS total',
      'SELECT COALESCE(ABS(SUM(amount)), 0)::float AS total',
      'SELECT "userId", SUM(amount::numeric) AS total_deposited',
      'SUM(ABS(w.amount::numeric))  AS wd_total,',
      "COALESCE(SUM(CASE WHEN t.type = 'free_credit' THEN t.amount ELSE 0 END), 0)",
      "COALESCE(SUM(CASE WHEN type IN ('referral_bonus','referral_prize') THEN amount ELSE 0 END), 0)",
    ];
    for (const shape of shapes) {
      expect({ shape, matched: matchesSum(shape) }).toEqual({
        shape,
        matched: true,
      });
    }
  });

  it("does not match sums over other columns", () => {
    expect(matchesSum("SELECT SUM(bondAmount) FROM disputes")).toBe(false);
    expect(matchesSum("SELECT COUNT(*) FROM transactions")).toBe(false);
    expect(matchesSum('.addSelect("SUM(t.stakeAmount)", "staked")')).toBe(false);
  });

  it("recognises a currency-scoped query as scoped", () => {
    const scoped = [
      '.andWhere("t.currency = :currency", { currency })',
      'WHERE "userId" = $1 AND currency = $2',
      "AND t.currency IN ('BTN')",
      "return ledgerBalance(em, userId, BTN_CURRENCY);",
      "const bal = await ledgerBalance(em, userId, currency);",
    ];
    for (const line of scoped) {
      expect({ line, scoped: SCOPES_CURRENCY.test(line) }).toEqual({
        line,
        scoped: true,
      });
    }
  });

  it("treats GROUP BY currency as scoping", () => {
    expect(GROUPS_BY_CURRENCY.test('.addGroupBy("t.currency")')).toBe(true);
    expect(GROUPS_BY_CURRENCY.test('.groupBy("currency")')).toBe(true);
    expect(GROUPS_BY_CURRENCY.test("GROUP BY t.type, t.currency")).toBe(true);
    expect(GROUPS_BY_CURRENCY.test('.addGroupBy("t.type")')).toBe(false);
    expect(GROUPS_BY_CURRENCY.test("GROUP BY t.type")).toBe(false);
  });

  it("does not accept a passing mention of currency as scoping", () => {
    // The exact way this guard would rot: a comment satisfies it and the
    // query underneath stays unfiltered.
    expect(SCOPES_CURRENCY.test("// TODO: scope this by currency one day")).toBe(
      false,
    );
    expect(SCOPES_CURRENCY.test("/** returns the currency-agnostic total */")).toBe(
      false,
    );
  });
});

describe("ledgerBalancesByAccountCurrency", () => {
  it("keys balances by account *and* currency", async () => {
    // The bug this replaces: `ledgerBalancesForAccounts` scopes to
    // `users.currency`, so a Bhutanese account settling a USDT book had its
    // payout row stamped with a balanceBefore taken from its ngultrum balance.
    // The amount was right — derived balances stayed correct — but the row
    // described a balance in a currency it was not in, and that figure is
    // printed straight back to the user as "Bal X".
    const captured: { sql?: string } = {};
    const em: any = {
      getRepository: () => ({
        createQueryBuilder: () => {
          const qb: any = {
            select: () => qb,
            addSelect: () => qb,
            where: () => qb,
            groupBy: (expr: string) => {
              captured.sql = expr;
              return qb;
            },
            getRawMany: async () => [
              { userId: "u1", currency: "BTN", balance: "500" },
              { userId: "u1", currency: "USDT", balance: "12" },
            ],
          };
          return qb;
        },
      }),
    };

    const balances = await ledgerBalancesByAccountCurrency(em, ["u1"]);

    expect(balances.get(balanceKey("u1", "BTN"))).toBe(500);
    expect(balances.get(balanceKey("u1", "USDT"))).toBe(12);
    // Never summed: there is no rate between them.
    expect(balances.size).toBe(2);
    // Grouped on both dimensions, in one expression the engine's hand-rolled
    // query-builder stubs can satisfy.
    expect(captured.sql).toBe("t.userId, t.currency");
  });

  it("returns an empty map for no accounts without querying", async () => {
    const em: any = {
      getRepository: () => {
        throw new Error("should not query");
      },
    };
    expect((await ledgerBalancesByAccountCurrency(em, [])).size).toBe(0);
  });
});
