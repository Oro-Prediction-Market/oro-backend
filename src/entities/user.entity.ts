import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from "typeorm";
import { Exclude } from "class-transformer";
import { AuthMethod } from "./auth-method.entity";
import { Position } from "./position.entity";
import { Payment } from "./payment.entity";
import { Transaction } from "./transaction.entity";

export enum KycStatus {
  /** Not applicable — provider-verified accounts never enter document review. */
  NONE = "none",
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}

// Declared at class level rather than as a property decorator: the property
// form does not register, and DB_SYNCHRONIZE drops any index it cannot find in
// entity metadata.
@Index("IDX_users_kycStatus", ["kycStatus"])
// Backs the admin user-growth panel, which filters and groups on createdAt.
@Index("IDX_users_createdAt", ["createdAt"])
@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index({ unique: true })
  @Column({ type: "varchar", nullable: true })
  telegramId: string | null;

  @Column({ type: "int", nullable: true })
  telegramStreak: number | null;

  // ── Daily bet streak ──────────────────────────────────────────────────────

  /** How many consecutive calendar days the user has placed at least one bet. */
  @Column({ default: 0 })
  betStreakCount: number;

  /** UTC calendar date (YYYY-MM-DD) of the last day a bet was placed. */
  @Column({ type: "date", nullable: true })
  betStreakLastAt: string | null;

  /**
   * True once the 1.2x day-7 boost payout has been applied for the current
   * 7-day cycle. Reset to false when the cycle restarts (day 1 of next cycle).
   */
  @Column({ default: false })
  streakBoostUsed: boolean;

  @Column({ type: "varchar", nullable: true })
  firstName: string | null;

  @Column({ type: "varchar", nullable: true })
  lastName: string | null;

  @Index({ unique: true, sparse: true } as any)
  @Column({ type: "varchar", nullable: true, unique: true })
  username: string | null;

  @Column({ type: "varchar", nullable: true })
  photoUrl: string | null;

  @Column({ default: false })
  isAdmin: boolean;

  /**
   * May read KYC documents and decide on them.
   *
   * Deliberately not implied by `isAdmin`. Admin access means moving money and
   * resolving markets; this means looking at strangers' passports. Different
   * permission, different people.
   */
  @Column({ default: false })
  isKycReviewer: boolean;

  @Index({ unique: true, sparse: true } as any)
  @Column({ type: "varchar", nullable: true, unique: true })
  dkCid: string | null;

  @Index({ unique: true, sparse: true } as any)
  @Column({ type: "varchar", nullable: true, unique: true })
  dkAccountNumber: string | null;

  @Column({ type: "varchar", nullable: true })
  dkAccountName: string | null;

  @Column({ type: "varchar", nullable: true })
  phoneNumber: string | null;

  @Index({ unique: true, sparse: true } as any)
  @Column({ type: "varchar", nullable: true, unique: true })
  email: string | null;

  /** Telegram chat_id bound during phone-verification handshake. */
  @Index({ unique: true, sparse: true } as any)
  @Column({ type: "varchar", nullable: true, unique: true })
  telegramChatId: string | null;

  /**
   * HMAC-SHA-256 hash of the Telegram-shared phone number.
   * Compared against dkPhoneHash on every payment to confirm identity.
   * NEVER stores the raw phone number.
   */
  @Exclude()
  @Column({ type: "varchar", nullable: true })
  telegramPhoneHash: string | null;

  /**
   * HMAC-SHA-256 hash of the phone number returned by DK Bank for this CID.
   * Set at registration / DK-link time.
   */
  @Exclude()
  @Column({ type: "varchar", nullable: true })
  dkPhoneHash: string | null;

  /** Timestamp when the Telegram account was successfully phone-verified. */
  @Column({ type: "timestamptz", nullable: true })
  telegramLinkedAt: Date | null;

  /**
   * Set when a user verifies ownership of their DK Bank account via account
   * number (fallback path for users whose Telegram phone differs from their
   * DK Bank registered phone — e.g. Bhutanese users living abroad).
   * Either this OR matching telegramPhoneHash/dkPhoneHash is sufficient to
   * authorise payments.
   */
  @Column({ type: "timestamptz", nullable: true })
  dkLinkVerifiedAt: Date | null;

  // Reputation

  /** Overall accuracy score 0.0–1.0 (confidence-adjusted). Starts at 0.5 for new users. */
  @Column({
    type: "decimal",
    precision: 5,
    scale: 4,
    nullable: true,
    default: 0.5,
  })
  reputationScore: number | null;

  /** 'rookie' | 'sharpshooter' | 'hot_hand' | 'legend' */
  @Column({ default: "rookie" })
  reputationTier: string;

  /** Total resolved predictions (won + lost, excludes refunded). */
  @Column({ default: 0 })
  totalPredictions: number;

  /** Total correct predictions. */
  @Column({ default: 0 })
  correctPredictions: number;

  /**
   * Per-category accuracy scores stored as JSON.
   * Shape: { sports: { correct: 3, total: 5 }, gaming: { correct: 1, total: 2 }, ... }
   */
  @Column({ type: "jsonb", nullable: true })
  categoryScores: Record<string, { correct: number; total: number }> | null;

  /** Up to three earned collectible IDs the user chooses to display publicly. */
  @Column({ type: "jsonb", nullable: true, default: () => "'[]'" })
  featuredAchievementIds: string[];

  /**
   * Badge IDs the user has already been notified about. Dedupe key for
   * achievement notifications so a badge is never re-notified — checking this
   * instead of "does a notification row still exist" means clearing/deleting an
   * achievement notification doesn't resurrect it on the next profile sync.
   */
  @Column({ type: "jsonb", nullable: true, default: () => "'[]'" })
  notifiedAchievementIds: string[];

  /**
   * Monthly leaderboard podium finishes (top 3). Append-only; the tuple
   * (year, month, rank) is the dedupe key. Populated by the season rollover
   * when prizes are credited, and by a one-time backfill from closed seasons'
   * winnersSnapshot. Powers the Monthly Champion/Runner-Up/Third collectibles,
   * which — unlike every stat-derived badge — can't be computed client-side.
   */
  @Column({ type: "jsonb", nullable: true, default: () => "'[]'" })
  monthlyPodiums: Array<{ year: number; month: number; rank: number }>;

  /**
   * Brier score — measures calibration quality (lower = better, 0–1).
   * Computed as rolling average of (predictedProbability - actual)² across
   * all resolved predictions. Null until first prediction with a stored prob.
   */
  @Column({ type: "decimal", precision: 5, scale: 4, nullable: true })
  brierScore: number | null;

  /** Number of observations included in the rolling brierScore average. */
  @Column({ default: 0 })
  brierCount: number;

  /**
   * Timestamp of the user's most recent position placement.
   * Used to compute time-based reputation decay.
   */
  @Column({ type: "timestamptz", nullable: true })
  lastActiveAt: Date | null;

  /**
   * Number of times the user bet AGAINST the Expert-weighted signal
   * and won. Incremented at settlement. Used for the Contrarian badge.
   */
  @Column({ default: 0 })
  contrarianWins: number;

  /**
   * Number of times the user bet against the Expert-weighted signal
   * (regardless of outcome). Denominator for contrarianWinRate.
   */
  @Column({ default: 0 })
  contrarianAttempts: number;

  /**
   * Badge tier: null = no badge, 'bronze' = 3+, 'silver' = 7+, 'gold' = 15+ contrarian wins
   * with win-rate ≥ 55%.
   */
  @Column({ type: "varchar", nullable: true })
  contrarianBadge: string | null;

  /**
   * Power Cards inventory — earned by reaching duel win milestones.
   * { doubleDown: N, shield: N, ghost: N }
   * Null treated as all zeros until first card is awarded.
   */
  @Column({ type: "jsonb", nullable: true })
  cardInventory: { doubleDown: number; shield: number; ghost: number } | null;

  /**
   * True once the one-time Nu 20 welcome free credit has been granted.
   * Prevents double-granting on re-login.
   */
  @Column({ default: false })
  freeCreditGranted: boolean;

  // ── Admin accountability ───────────────────────────────────────────────────

  /**
   * Total number of markets this admin has manually resolved (final resolution).
   * Incremented every time POST /admin/markets/:id/resolve succeeds.
   */
  @Column({ default: 0 })
  adminTotalResolutions: number;

  /**
   * Number of times this admin's resolution was overturned —
   * i.e. at least one objector was UPHELD (admin changed the outcome after review).
   * A high ratio of wrongResolutions / totalResolutions is a red flag.
   */
  @Column({ default: 0 })
  adminWrongResolutions: number;

  /**
   * The account's currency: 'BTN' or 'USDT'. Set once at creation and never
   * changed.
   *
   * There is deliberately no application code path that updates this column,
   * and that absence is the segregation guarantee — it is what makes it
   * impossible for a user to cross between the BTN and USDT books. A user's
   * currency decides which ledger rows are theirs, which book of a market they
   * may stake into, and which rail they withdraw through.
   *
   * See docs/usdt-oro/SEGREGATION-MODEL.md.
   */
  @Column({ type: "varchar", length: 10, default: "BTN" })
  currency: string;

  /**
   * Where this account sits in document review.
   *
   * `NONE` for every existing user, and for every BhutanApp, DK Bank or
   * Telegram account: those are verified through their provider and never
   * enter this queue. Only email accounts move pending → approved.
   *
   * Denormalised from `user_kyc_documents` so the deposit gate does not join.
   * The gate is on deposit, not withdrawal — blocking withdrawal would mean
   * taking money from someone we may then refuse to pay.
   */
  @Column({ type: "enum", enum: KycStatus, default: KycStatus.NONE })
  kycStatus: KycStatus;

  /**
   * When the email address was confirmed.
   *
   * An unverified address must not reach document upload, or the review queue
   * fills with documents belonging to addresses nobody controls.
   */
  @Column({ type: "timestamptz", nullable: true })
  emailVerifiedAt: Date | null;

  /**
   * Running total of bonus (free-credit) balance still in play.
   * Incremented when FREE_CREDIT is granted; decremented when bonus bets settle.
   * Used to enforce the Nu 50 withdrawable cap on bonus winnings.
   */
  @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
  bonusBalance: number;

  /**
   * How much real (withdrawable) money this user can still extract from
   * bonus-funded winning bets. Resets to 50 on each new free credit grant.
   * Decremented each time a bonus bet pays out real money. Once 0, all
   * bonus bet wins become play credits only.
   */
  @Column({ type: "decimal", precision: 18, scale: 2, default: 50 })
  bonusRealPayoutRemaining: number;

  // ── Referral ───────────────────────────────────────────────────────────────

  /**
   * The user ID of whoever referred this user.
   * Set once at registration if the user opened the bot via a referral deep-link.
   * Null for organic sign-ups.
   */
  @Column({ type: "uuid", nullable: true })
  referredByUserId: string | null;

  /**
   * bcryptjs hash of the user's self-chosen PWA login password.
   * Set from the TMA Settings page. Null = no PWA password set yet
   * (CID-only login is allowed for backwards compat until the user sets one).
   */
  @Exclude()
  @Column({ type: "varchar", nullable: true })
  pwaPasswordHash: string | null;

  /**
   * True once the referrer has been credited their bonus for this user's first bet.
   * Ensures the bonus fires exactly once regardless of how many bets this user places.
   */
  @Column({ default: false })
  referralBonusTriggered: boolean;

  /**
   * True once this user has been paid their Nu 500 referral prize pool reward
   * for reaching the REFERRAL_PRIZE_THRESHOLD converted referrals.
   * Ensures the prize fires exactly once.
   */
  @Column({ default: false })
  referralPrizeClaimed: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => AuthMethod, (am) => am.user)
  authMethods: AuthMethod[];

  @OneToMany(() => Position, (p) => p.user)
  positions: Position[];

  @OneToMany(() => Payment, (p) => p.user)
  payments: Payment[];

  @OneToMany(() => Transaction, (t) => t.user)
  transactions: Transaction[];
}
