import {
  Challenge,
  ChallengeStatus,
  CardType,
} from "../entities/challenge.entity";
import { MarketStatus } from "../entities/market.entity";

/**
 * A duel stranded by a cancelled market.
 *
 * ParimutuelEngine.cancelMarket() refunds positions and releases dispute bonds
 * but never calls ChallengesService.settleByMarket(), so an open or active duel
 * on a cancelled market is never settled, never expired and never refunded —
 * both wagers stay debited with no code path back. Surfacing these is the
 * reason the admin duels page exists; the fix belongs in cancelMarket.
 *
 * Written once and shared by the list filter and the summary count so the two
 * cannot drift apart on what "stuck" means. Requires the market joined as `m`.
 */
export const STUCK_DUEL = `c.status IN ('open','active') AND m.status = 'cancelled'`;

/**
 * Mirrors PLATFORM_FEE_PCT in challenges.service.ts, which is module-private.
 * Used only to DISPLAY what a duel's cut was, or would be — nothing here pays
 * anyone.
 */
export const DUEL_PLATFORM_FEE_PCT = 0.1;

export interface DuelRow {
  id: string;
  status: ChallengeStatus;
  wagerAmount: number;
  pot: number;
  platformFee: number;
  feeWaived: boolean;
  currency: string;
  equippedCard: CardType | null;
  participantCount: number;
  createdAt: Date;
  expiresAt: Date;
  settledAt: Date | null;
  winnerId: string | null;
  creator: DuelParty | null;
  joiner: DuelParty | null;
  market: { id: string; title: string; status: string } | null;
  outcome: { id: string; label: string } | null;
  stuck: boolean;
}

interface DuelParty {
  id: string;
  username: string | null;
  firstName: string | null;
}

/** True when a duel can no longer reach a terminal state on its own. */
export function isStuck(
  status: ChallengeStatus,
  marketStatus: string | null | undefined,
): boolean {
  return (
    (status === ChallengeStatus.OPEN || status === ChallengeStatus.ACTIVE) &&
    marketStatus === MarketStatus.CANCELLED
  );
}

/**
 * Flatten a duel for the admin table, deriving the three things the UI needs
 * and the schema does not hold: the pot, the platform's cut, and whether the
 * duel is stranded.
 *
 * `wagerAmount` is a decimal column, so TypeORM hands it back as a STRING.
 * Everything goes through Number() first — string arithmetic here would
 * silently produce "2525" where 50 was meant.
 */
export function toDuelRow(c: Challenge): DuelRow {
  const wager = Number(c.wagerAmount ?? 0);
  const pot = wager * 2;
  // Double Down waives the fee. Only the creator can equip it, so a joiner who
  // wins still benefits from their opponent's card.
  const feeWaived = c.equippedCard === CardType.DOUBLE_DOWN;
  const marketStatus = c.market?.status ?? null;

  return {
    id: c.id,
    status: c.status,
    wagerAmount: wager,
    pot,
    platformFee: feeWaived ? 0 : pot * DUEL_PLATFORM_FEE_PCT,
    feeWaived,
    currency: c.currency,
    equippedCard: c.equippedCard,
    participantCount: c.participantCount,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    settledAt: c.settledAt,
    winnerId: c.winnerId,
    creator: party(c.creator),
    // Null while a duel is open, and null forever if it expired unjoined.
    joiner: party(c.joiner),
    market: c.market
      ? { id: c.market.id, title: c.market.title, status: marketStatus as string }
      : null,
    outcome: c.outcome ? { id: c.outcome.id, label: c.outcome.label } : null,
    stuck: isStuck(c.status, marketStatus),
  };
}

function party(u: Challenge["creator"] | null): DuelParty | null {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username ?? null,
    firstName: u.firstName ?? null,
  };
}
