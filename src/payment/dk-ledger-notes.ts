/**
 * Notes written onto DK ledger rows.
 *
 * A withdrawal's debit is written before the bank call and carries
 * {@link WITHDRAWAL_RESERVED}; once DK confirms, the same row is restamped
 * with {@link WITHDRAWAL_CONFIRMED}. The transition is what the user reads in
 * their history, so "reserved" must not outlive a payout that completed.
 *
 * Only the note changes — never the amount, and never the row's identity.
 *
 * Both `confirmWithdrawal` and the reconciler write these, which is why they
 * live here rather than as literals at each call site.
 */

/** Debit written, bank call not yet made or not yet answered. */
export const WITHDRAWAL_RESERVED = "DK Bank withdrawal reserved";

/** DK confirmed the payout; the debit stands. */
export const WITHDRAWAL_CONFIRMED = "DK Bank withdrawal confirmed";

/** DK definitively rejected the payout; the reserved funds were returned. */
export const WITHDRAWAL_REFUNDED =
  "DK Bank withdrawal failed — reserved funds returned";
