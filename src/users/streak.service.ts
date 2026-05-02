import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";

export const STREAK_BONUS_DAY = 7; // day on which the boost fires
export const STREAK_BONUS_MULT = 1.2; // 20 % extra payout

export interface StreakUpdateResult {
  newStreak: number;
  /** True when the current bet triggers the 1.2x boost */
  boostActive: boolean;
  /** Day number within the current cycle (1–7) */
  dayInCycle: number;
}

@Injectable()
export class StreakService {
  private readonly logger = new Logger(StreakService.name);

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Transaction)
    private transactionRepo: Repository<Transaction>,
    @InjectDataSource() private dataSource: DataSource,
  ) {}

  /**
   * Called immediately after a successful bet placement (inside or just after
   * the DB transaction). Updates betStreakCount / betStreakLastAt / streakBoostUsed
   * and returns streak metadata for the response.
   */
  async updateStreak(userId: string): Promise<StreakUpdateResult> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ["id", "betStreakCount", "betStreakLastAt", "streakBoostUsed"],
    });

    if (!user) {
      return { newStreak: 1, boostActive: false, dayInCycle: 1 };
    }

    const todayUtc = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastDate = user.betStreakLastAt;

    let newStreak: number;
    let streakBoostUsed = user.streakBoostUsed;

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

      if (lastDate === yesterdayUtc) {
        // Consecutive day
        newStreak = (user.betStreakCount || 0) + 1;
        // If we just crossed a new cycle (streak reset to 1 after boost), reset flag
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
      user.streakBoostUsed !== streakBoostUsed
    ) {
      await this.userRepo.update(userId, {
        betStreakCount: newStreak,
        betStreakLastAt: todayUtc,
        streakBoostUsed,
      });
    }

    this.logger.log(
      `Streak update user=${userId} streak=${newStreak} day=${dayInCycle} boost=${boostActive}`,
    );

    return { newStreak, boostActive, dayInCycle };
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

    const count = user.betStreakCount || 0;
    const dayInCycle = count === 0 ? 0 : ((count - 1) % STREAK_BONUS_DAY) + 1;
    const nextBoostInDays = STREAK_BONUS_DAY - dayInCycle;
    const todayUtc = new Date().toISOString().slice(0, 10);
    const betToday = user.betStreakLastAt === todayUtc;

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
      const { balance: rawBefore } = await em
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId = :userId", { userId })
        .getRawOne();

      const balanceBefore = Number(rawBefore);

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

    this.logger.log(
      `Streak bonus credited user=${userId} bonus=${bonusAmount}`,
    );
  }
}
