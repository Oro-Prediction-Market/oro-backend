/**
 * Comprehensive DEV seed — populates the core tables with interconnected fake
 * data (users, markets, outcomes, positions, transactions, payments,
 * settlements, disputes) so a freshly-reset local DB looks alive.
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/dev-seed.ts
 * Safe to re-run: it no-ops if the seed users already exist.
 *
 * NOTE: development only — do NOT run against a real database.
 */
import "reflect-metadata";
import { DataSource } from "typeorm";
import * as dotenv from "dotenv";
import { DEFAULT_HOUSE_EDGE_PCT } from "./markets/fee.constants";
import { User } from "./entities/user.entity";
import { Market, MarketStatus, MarketCategory } from "./entities/market.entity";
import { Outcome } from "./entities/outcome.entity";
import { Position, PositionStatus } from "./entities/position.entity";
import { Transaction, TransactionType } from "./entities/transaction.entity";
import {
  Payment,
  PaymentType,
  PaymentStatus,
  PaymentMethod,
} from "./entities/payment.entity";
import { Settlement } from "./entities/settlement.entity";
import { Dispute, DisputeSide, DisputeBondStatus } from "./entities/dispute.entity";

dotenv.config();

const ds = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "oro_db",
  synchronize: true, // create any missing tables on a fresh DB
  logging: false,
  entities: [__dirname + "/entities/*.entity.{ts,js}"],
});

const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const round2 = (n: number) => Math.round(n * 100) / 100;
const pick = <T>(arr: T[], i: number) => arr[i % arr.length];

async function seed() {
  await ds.initialize();
  console.log("✅ Connected + schema ensured\n");

  const userRepo = ds.getRepository(User);
  const marketRepo = ds.getRepository(Market);
  const outcomeRepo = ds.getRepository(Outcome);
  const posRepo = ds.getRepository(Position);
  const txRepo = ds.getRepository(Transaction);
  const payRepo = ds.getRepository(Payment);
  const settleRepo = ds.getRepository(Settlement);
  const disputeRepo = ds.getRepository(Dispute);

  if (await userRepo.findOne({ where: { username: "alice" } })) {
    console.log("ℹ️  Seed users already exist — nothing to do.");
    await ds.destroy();
    return;
  }

  // ── Running per-user balance so tx.balanceBefore/After stay coherent ────────
  const bal = new Map<string, number>();
  async function addTx(
    userId: string,
    type: TransactionType,
    amount: number,
    extra: Partial<Transaction> = {},
  ) {
    const before = bal.get(userId) ?? 0;
    const after = round2(before + amount);
    bal.set(userId, after);
    await txRepo.save(
      txRepo.create({
        userId,
        type,
        amount,
        balanceBefore: before,
        balanceAfter: after,
        ...extra,
      }),
    );
  }

  // ── 1. Users (admin + 8 punters, a few DK-linked) ──────────────────────────
  const admin = await userRepo.save(
    userRepo.create({
      firstName: "Tara",
      lastName: "Admin",
      username: "admin",
      isAdmin: true,
    }),
  );
  const names = [
    ["alice", "Alice", "Dorji"],
    ["bob", "Bob", "Wangchuk"],
    ["charlie", "Charlie", "Tshering"],
    ["dave", "Dave", "Namgyel"],
    ["eve", "Eve", "Lhamo"],
    ["frank", "Frank", "Gyeltshen"],
    ["grace", "Grace", "Choden"],
    ["heidi", "Heidi", "Zangmo"],
  ];
  const users: User[] = [];
  for (let i = 0; i < names.length; i++) {
    const [username, firstName, lastName] = names[i];
    const u = await userRepo.save(
      userRepo.create({
        username,
        firstName,
        lastName,
        telegramId: String(100000 + i),
        phoneNumber: `9751700${1000 + i}`,
        dkCid: `1100${String(100000000 + i)}`,
        dkAccountNumber: `1101${String(46039000 + i)}`,
        dkAccountName: `${firstName} ${lastName}`,
        reputationScore: round2(0.4 + i * 0.05),
        totalPredictions: 5 + i,
        correctPredictions: 2 + (i % 4),
      }),
    );
    users.push(u);
  }
  console.log(`✅ Users: ${users.length + 1} (admin + ${users.length} punters)`);

  // ── 2. Give each punter a starting deposit (balance + matching Payment) ─────
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const amount = pick([1000, 1500, 2000, 3000, 800, 2500], i);
    const pay = await payRepo.save(
      payRepo.create({
        userId: u.id,
        type: PaymentType.DEPOSIT,
        method: PaymentMethod.DK_BANK,
        status: PaymentStatus.SUCCESS,
        amount,
        currency: "BTN",
        externalPaymentId: `DK-DEP-${1000 + i}`,
        confirmedAt: days(-10 + i),
        description: "DK Bank deposit",
      }),
    );
    await addTx(u.id, TransactionType.DEPOSIT, amount, {
      paymentId: pay.id,
      note: "DK Bank deposit",
    });
  }
  console.log(`✅ Deposits: ${users.length} (balances funded)`);

  // ── 3. Markets in a spread of lifecycle states ──────────────────────────────
  type Seeded = { market: Market; outcomes: Outcome[] };
  async function makeMarket(
    fields: Partial<Market>,
    outcomeLabels: string[],
  ): Promise<Seeded> {
    const market = await marketRepo.save(
      marketRepo.create({
        mechanism: undefined as any, // entity default = parimutuel
        houseEdgePct: DEFAULT_HOUSE_EDGE_PCT,
        totalPool: 0,
        ...fields,
      }),
    );
    const outcomes: Outcome[] = [];
    for (let i = 0; i < outcomeLabels.length; i++) {
      outcomes.push(
        await outcomeRepo.save(
          outcomeRepo.create({
            marketId: market.id,
            label: outcomeLabels[i],
            totalBetAmount: 0,
            sortOrder: i,
          }),
        ),
      );
    }
    return { market, outcomes };
  }

  // Helper: place a bet → Position + POSITION_OPENED tx, roll up pool totals.
  async function placeBet(
    user: User,
    seeded: Seeded,
    outcomeIdx: number,
    amount: number,
    status: PositionStatus = PositionStatus.PENDING,
  ) {
    const outcome = seeded.outcomes[outcomeIdx];
    const pos = await posRepo.save(
      posRepo.create({
        userId: user.id,
        marketId: seeded.market.id,
        outcomeId: outcome.id,
        amount,
        status,
        oddsAtPlacement: 2.0,
      }),
    );
    await addTx(user.id, TransactionType.POSITION_OPENED, -amount, {
      positionId: pos.id,
      stakeAmount: amount,
      note: `Bet on ${outcome.label}`,
    });
    outcome.totalBetAmount = round2(Number(outcome.totalBetAmount) + amount);
    seeded.market.totalPool = round2(Number(seeded.market.totalPool) + amount);
    return pos;
  }

  // M1 — OPEN sports
  const m1 = await makeMarket(
    {
      title: "Bhutan vs Nepal — SAFF Qualifier",
      description: "Who wins the SAFF qualifier?",
      status: MarketStatus.OPEN,
      category: MarketCategory.SPORTS,
      subcategory: "football",
      resolutionCriteria: "Official SAFF result at full time.",
      opensAt: days(-2),
      closesAt: days(3),
      bettingClosesAt: days(3),
    },
    ["Bhutan", "Nepal"],
  );
  // M2 — OPEN weather
  const m2 = await makeMarket(
    {
      title: "Will it rain in Thimphu this Saturday?",
      description: "Any measurable rainfall in Thimphu on Saturday.",
      status: MarketStatus.OPEN,
      category: MarketCategory.WEATHER,
      resolutionCriteria: "NCHM Thimphu station reading.",
      opensAt: days(-1),
      closesAt: days(4),
      bettingClosesAt: days(4),
    },
    ["Yes", "No"],
  );
  // M3 — RESOLVING gaming (proposed + objection window open) → will get a dispute
  const m3 = await makeMarket(
    {
      title: "MLBB Grand Final: Falcons vs Dragons",
      description: "Mobile Legends national grand final.",
      status: MarketStatus.RESOLVING,
      category: MarketCategory.GAMING,
      subcategory: "mlbb",
      resolutionCriteria: "Best-of-7 series winner.",
      opensAt: days(-6),
      closesAt: days(-1),
      bettingClosesAt: days(-1),
      windowMinutes: 120,
      disputeDeadlineAt: days(1),
    },
    ["Falcons", "Dragons"],
  );
  // M4 — SETTLED sports (Paro wins)
  const m4 = await makeMarket(
    {
      title: "Paro vs Punakha — Dragon Cup",
      description: "Domestic Dragon Cup fixture.",
      status: MarketStatus.SETTLED,
      category: MarketCategory.SPORTS,
      subcategory: "football",
      resolutionCriteria: "Official result at full time.",
      opensAt: days(-14),
      closesAt: days(-7),
      bettingClosesAt: days(-7),
      resolvedAt: days(-6),
    },
    ["Paro", "Punakha"],
  );

  // ── 4. Positions across the markets ─────────────────────────────────────────
  // M1: mixed bets, all pending
  await placeBet(users[0], m1, 0, 200);
  await placeBet(users[1], m1, 0, 150);
  await placeBet(users[2], m1, 1, 300);
  await placeBet(users[3], m1, 1, 100);
  await placeBet(users[4], m1, 0, 250);
  // M2: yes/no
  await placeBet(users[5], m2, 0, 120);
  await placeBet(users[6], m2, 1, 180);
  await placeBet(users[7], m2, 1, 90);
  // M3: resolving (bets pending until settle)
  await placeBet(users[0], m3, 0, 500);
  await placeBet(users[1], m3, 1, 400);
  await placeBet(users[2], m3, 0, 350);

  // M4: SETTLED — Paro (idx 0) won. Winners WON + payout tx, losers LOST.
  const m4bets = [
    { u: users[3], idx: 0, amt: 300 }, // winner
    { u: users[4], idx: 0, amt: 200 }, // winner
    { u: users[5], idx: 1, amt: 250 }, // loser
    { u: users[6], idx: 1, amt: 150 }, // loser
  ];
  const m4winnerStake = 300 + 200;
  const m4pool = 300 + 200 + 250 + 150; // 900
  const m4house = round2(m4pool * (DEFAULT_HOUSE_EDGE_PCT / 100)); // 90
  const m4payoutPool = round2(m4pool - m4house); // 810
  let m4paid = 0;
  for (const b of m4bets) {
    const won = b.idx === 0;
    const pos = await placeBet(
      b.u,
      m4,
      b.idx,
      b.amt,
      won ? PositionStatus.WON : PositionStatus.LOST,
    );
    if (won) {
      const payout = round2(m4payoutPool * (b.amt / m4winnerStake));
      m4paid = round2(m4paid + payout);
      pos.payout = payout;
      await posRepo.save(pos);
      await addTx(b.u.id, TransactionType.POSITION_PAYOUT, payout, {
        positionId: pos.id,
        stakeAmount: b.amt,
        note: `Payout for winning prediction on Paro`,
      });
    }
  }
  m4.outcomes[0].isWinner = true;
  await outcomeRepo.save(m4.outcomes[0]);
  m4.market.resolvedOutcomeId = m4.outcomes[0].id;
  await settleRepo.save(
    settleRepo.create({
      marketId: m4.market.id,
      winningOutcomeId: m4.outcomes[0].id,
      totalPositions: m4bets.length,
      winningPositions: 2,
      totalPool: m4pool,
      houseAmount: round2(m4pool - m4paid), // exact residual
      payoutPool: m4payoutPool,
      totalPaidOut: m4paid,
    }),
  );

  // Persist rolled-up outcome + pool totals for every market
  for (const s of [m1, m2, m3, m4]) {
    await outcomeRepo.save(s.outcomes);
    await marketRepo.save(s.market);
  }
  console.log("✅ Markets: 4 (open x2, resolving x1, settled x1) + positions + payouts");

  // ── 5. A dispute on the RESOLVING market ────────────────────────────────────
  m3.market.proposedOutcomeId = m3.outcomes[0].id; // "Falcons" proposed
  m3.market.disputeBondPool = 10;
  await marketRepo.save(m3.market);
  const objector = users[1]; // backed Dragons → objects to Falcons
  await addTx(objector.id, TransactionType.DISPUTE_BOND_LOCK, -10, {
    note: "Objection bond locked",
  });
  await disputeRepo.save(
    disputeRepo.create({
      userId: objector.id,
      marketId: m3.market.id,
      reason: "Series went to game 7 — Dragons took the final map.",
      side: DisputeSide.OBJECT,
      bondAmount: 10,
      bondStatus: DisputeBondStatus.LOCKED,
    }),
  );
  console.log("✅ Dispute: 1 (open objection on the resolving market)");

  // ── 6. A few withdrawals in different states ────────────────────────────────
  // SUCCESS withdrawal (debit only)
  const wSucc = await payRepo.save(
    payRepo.create({
      userId: users[0].id,
      type: PaymentType.WITHDRAWAL,
      method: PaymentMethod.DK_BANK,
      status: PaymentStatus.SUCCESS,
      amount: 100,
      externalPaymentId: "DK-WD-2001",
      confirmedAt: days(-3),
      description: "DK Bank withdrawal",
    }),
  );
  await addTx(users[0].id, TransactionType.WITHDRAWAL, -100, {
    paymentId: wSucc.id,
    note: "DK Bank withdrawal",
  });
  // PROCESSING withdrawal (debit reserved, awaiting reconciliation — the #4 case)
  const wProc = await payRepo.save(
    payRepo.create({
      userId: users[2].id,
      type: PaymentType.WITHDRAWAL,
      method: PaymentMethod.DK_BANK,
      status: PaymentStatus.PROCESSING,
      amount: 75,
      description: "DK Bank withdrawal — awaiting confirmation",
      failureReason: "DK Bank returned an indeterminate status",
    }),
  );
  await addTx(users[2].id, TransactionType.WITHDRAWAL, -75, {
    paymentId: wProc.id,
    note: "DK Bank withdrawal reserved",
  });
  // FAILED withdrawal (debit + refund, net zero)
  const wFail = await payRepo.save(
    payRepo.create({
      userId: users[4].id,
      type: PaymentType.WITHDRAWAL,
      method: PaymentMethod.DK_BANK,
      status: PaymentStatus.FAILED,
      amount: 50,
      description: "DK Bank withdrawal",
      failureReason: "Recipient account inactive",
      confirmedAt: days(-2),
    }),
  );
  await addTx(users[4].id, TransactionType.WITHDRAWAL, -50, {
    paymentId: wFail.id,
    note: "DK Bank withdrawal reserved",
  });
  await addTx(users[4].id, TransactionType.REFUND, 50, {
    note: "DK Bank withdrawal failed — reserved funds returned",
  });
  console.log("✅ Withdrawals: 3 (success / processing / failed+refunded)");

  // ── Summary ─────────────────────────────────────────────────────────────────
  const counts: Record<string, number> = {
    users: await userRepo.count(),
    markets: await marketRepo.count(),
    outcomes: await outcomeRepo.count(),
    positions: await posRepo.count(),
    transactions: await txRepo.count(),
    payments: await payRepo.count(),
    settlements: await settleRepo.count(),
    disputes: await disputeRepo.count(),
  };
  console.log("\n── Row counts ──");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)}: ${v}`);
  console.log("\n✅ Dev seed complete.");
  await ds.destroy();
}

seed().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});
