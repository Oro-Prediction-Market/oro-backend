import { EntityManager } from "typeorm";
import {
  Payment,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from "../entities/payment.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { ledgerBalance } from "../shared/utils/ledger.util";

const USDT = "USDT";

export interface UsdtDepositCredit {
  userId: string;
  /** What arrived on chain, in whole USDT. Never an expected amount. */
  amount: number;
  /**
   * The 21 Pay intent id. `payments.externalPaymentId` is unique, so this is
   * the database-level exactly-once guard behind whatever the caller checks.
   * Invoice and HD deposits share the namespace on purpose: if 21 Pay ever
   * sent `credited` for an intent the invoice flow already settled, the
   * second credit fails here instead of paying twice.
   */
  externalPaymentId: string;
  network: string;
  metadata: Record<string, unknown>;
}

/**
 * Write a USDT deposit credit: one `payments` row and one ledger row.
 *
 * Shared by the invoice settlement and the HD wallet credit so the two cannot
 * drift apart. Must run inside the caller's transaction.
 */
export async function writeUsdtDepositCredit(
  em: EntityManager,
  credit: UsdtDepositCredit,
): Promise<{ paymentId: string; transactionId: string }> {
  const payment = await em.save(
    Payment,
    em.create(Payment, {
      userId: credit.userId,
      type: PaymentType.DEPOSIT,
      status: PaymentStatus.SUCCESS,
      method: PaymentMethod.USDT,
      amount: credit.amount,
      currency: USDT,
      externalPaymentId: credit.externalPaymentId,
      confirmedAt: new Date(),
      metadata: { network: credit.network, ...credit.metadata },
    }),
  );

  const balanceBefore = await ledgerBalance(em, credit.userId, USDT);

  const tx = await em.save(
    Transaction,
    em.create(Transaction, {
      userId: credit.userId,
      type: TransactionType.DEPOSIT,
      // We credit what arrived, always. Note this is what the *user* is owed;
      // our own claim on 21Pay is `amount − fee`, because they deduct a
      // per-tenant fee. Reconciliation models that difference; the credit
      // does not.
      amount: credit.amount,
      currency: USDT,
      balanceBefore,
      balanceAfter: balanceBefore + credit.amount,
      paymentId: payment.id,
      isBonus: false,
      note: `USDT deposit · ${credit.network}`,
    }),
  );

  return { paymentId: payment.id, transactionId: tx.id };
}
