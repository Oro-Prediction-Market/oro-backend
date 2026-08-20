import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { ledgerBalanceForAccount } from "../shared/utils/ledger.util";
import { SseService } from "../sse/sse.service";

export const STREAK_BONUS_DAY = 7; // day on which the boost fires
export const STREAK_BONUS_MULT = 1.2; // 20 % extra payout

export interface StreakUpdateResult {
  newStreak: number;
  /** True when the current bet triggers the 1.2x boost */
  boostActive: boolean;
  /** Day number within the current cycle (1–7) */
  dayInCycle: number;
  /** True when a Shield card was auto-spent to forgive a single missed day. */
  shieldSaved?: boolean;
}

type CardInventory = { doubleDown: number; shield: number; ghost: number };

/**
 * Normalize raw cardInventory. The original migration defaulted to '[]' (an
 * array) rather than an object, so old rows may hold [] — treat both as zeros.
 */
function normalizeInventory(raw: CardInventory | null): CardInventory {
  if (!raw || Array.isArray(raw)) return { doubleDown: 0, shield: 0, ghost: 0 };
  return {
    doubleDown: raw.doubleDown ?? 0,
    shield: raw.shield ?? 0,
    ghost: raw.ghost ?? 0,
  };
}

@Injectable()
export class StreakService {
  private readonly logger = new Logger(StreakService.name);

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Transaction)
    private transactionRepo: Repository<Transaction>,
    @InjectDataSource() private dataSource: DataSource,
    private sse: SseService,
  ) {}

  /**
   * Called immediately after a successful bet placement (inside or just after
   * the DB transaction). Updates betStreakCount / betStreakLastAt / streakBoostUsed
   * and returns streak metadata for the response.
   */
  async updateStreak(userId: string): Promise<StreakUpdateResult> {
    return this.dataSource.transaction(async (em) => {
      const userRepo = em.getRepository(User);

      const user = await userRepo.findOne({
        where: { id: userId },
        select: [
          "id",
          "betStreakCount",
          "betStreakLastAt",
          "streakBoostUsed",
          "cardInventory",
        ],
        lock: { mode: "pessimistic_write" },
      });

      if (!user) {
        return { newStreak: 1, boostActive: false, dayInCycle: 1 };
      }

      const todayUtc = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const lastDate = user.betStreakLastAt;

      let newStreak: number;
      let streakBoostUsed = user.streakBoostUsed;
      let shieldSaved = false;
      const inventory = normalizeInventory(user.cardInventory);
      let inventoryChanged = false;

      if (!lastDate) {
        // First ever bet
        newStreak = 1;
        streakBoostUsed = false;
      } else if (lastDate === todayUtc) {
        // Already bet today — streak unchanged
        newStreak = user.betStreakCount || 1;
      } else {
        const yesterday = new Date();
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const yesterdayUtc = yesterday.toISOString().slice(0, 10);
        const twoDaysAgo = new Date();
        twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
        const twoDaysAgoUtc = twoDaysAgo.toISOString().slice(0, 10);

        if (lastDate === yesterdayUtc) {
          // Consecutive day
          newStreak = (user.betStreakCount || 0) + 1;
          // If we just crossed a new cycle (streak reset to 1 after boost), reset flag
          if (newStreak % STREAK_BONUS_DAY === 1) streakBoostUsed = false;
        } else if (lastDate === twoDaysAgoUtc && inventory.shield >= 1) {
          // Exactly one day missed and the user holds a Shield card — auto-spend
          // it to bridge the gap and keep the streak alive. Only a single missed
          // day is forgivable; miss two+ days and the streak resets regardless.
          inventory.shield -= 1;
          inventoryChanged = true;
          shieldSaved = true;
          newStreak = (user.betStreakCount || 0) + 1;
          if (newStreak % STREAK_BONUS_DAY === 1) streakBoostUsed = false;
        } else {
          // Gap — reset
          newStreak = 1;
          streakBoostUsed = false;
        }
      }

      const dayInCycle = ((newStreak - 1) % STREAK_BONUS_DAY) + 1; // 1–7
      const isDay7 = dayInCycle === STREAK_BONUS_DAY;
      const boostActive = isDay7 && !streakBoostUsed && lastDate !== todayUtc;

      if (boostActive) streakBoostUsed = true;

      // Persist (only if something changed)
      if (
        user.betStreakCount !== newStreak ||
        user.betStreakLastAt !== todayUtc ||
        user.streakBoostUsed !== streakBoostUsed ||
        inventoryChanged
      ) {
        await userRepo.update(userId, {
          betStreakCount: newStreak,
          betStreakLastAt: todayUtc,
          streakBoostUsed,
          ...(inventoryChanged ? { cardInventory: inventory } : {}),
        });
      }

      this.logger.log(
        `Streak update user=${userId} streak=${newStreak} day=${dayInCycle} boost=${boostActive}${shieldSaved ? " shieldSaved" : ""}`,
      );

      return { newStreak, boostActive, dayInCycle, shieldSaved };
    });
  }

  /** Read-only snapshot for the /users/me endpoint. */
  async getStreakInfo(userId: string): Promise<{
    betStreakCount: number;
    dayInCycle: number;
    nextBoostInDays: number;
    boostReady: boolean;
  }> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ["betStreakCount", "betStreakLastAt", "streakBoostUsed"],
    });

    if (!user) {
      return {
        betStreakCount: 0,
        dayInCycle: 0,
        nextBoostInDays: 7,
        boostReady: false,
      };
    }

    const todayUtc = new Date().toISOString().slice(0, 10);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayUtc = yesterday.toISOString().slice(0, 10);

    const lastAt = user.betStreakLastAt;
    // A streak is only "alive" while the last bet was today or yesterday (UTC).
    // betStreakCount isn't reset in the DB until the next bet, so once a full
    // day is missed the stored value is stale — report 0 here so the UI hides
    // the streak instead of showing a broken one.
    const alive = lastAt === todayUtc || lastAt === yesterdayUtc;
    if (!alive) {
      return {
        betStreakCount: 0,
        dayInCycle: 0,
        nextBoostInDays: STREAK_BONUS_DAY,
        boostReady: false,
      };
    }

    const count = user.betStreakCount || 0;
    const dayInCycle = count === 0 ? 0 : ((count - 1) % STREAK_BONUS_DAY) + 1;
    const nextBoostInDays = STREAK_BONUS_DAY - dayInCycle;
    const betToday = lastAt === todayUtc;

    const boostReady =
      dayInCycle === STREAK_BONUS_DAY && !user.streakBoostUsed && betToday;

    return { betStreakCount: count, dayInCycle, nextBoostInDays, boostReady };
  }

  /**
   * Credit the 1.2x streak bonus as a ledger transaction so the user's
   * balance immediately reflects the bonus.
   */
  async creditStreakBonus(
    userId: string,
    positionId: string,
    bonusAmount: number,
  ): Promise<void> {
    if (bonusAmount <= 0) return;

    await this.dataSource.transaction(async (em) => {
      const balanceBefore = await ledgerBalanceForAccount(em, userId);

      await em.save(
        em.create(Transaction, {
          type: TransactionType.POSITION_PAYOUT,
          amount: bonusAmount,
          balanceBefore,
          balanceAfter: balanceBefore + bonusAmount,
          userId,
          positionId,
          note: `🔥 Day-7 streak bonus (+${STREAK_BONUS_MULT}x)`,
        }),
      );
    });

    this.sse.emit(userId, "balance:updated", { streakBonus: bonusAmount });

    this.logger.log(
      `Streak bonus credited user=${userId} bonus=${bonusAmount}`,
    );
  }
}
