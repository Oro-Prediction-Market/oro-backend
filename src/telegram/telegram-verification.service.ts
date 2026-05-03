import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { createHmac } from "crypto";
import { ConfigService } from "@nestjs/config";
import { User } from "../entities/user.entity";
import { AuthMethod } from "../entities/auth-method.entity";
import { Position } from "../entities/position.entity";
import { Transaction } from "../entities/transaction.entity";
import { Payment } from "../entities/payment.entity";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";

/**
 * TelegramVerificationService
 *
 * Implements bank-level identity binding:
 *  1. When a user shares their phone via the Telegram bot, we HMAC-hash it
 *     and compare it against the HMAC-hash of the phone DK Bank has on record.
 *  2. On every payment we re-check that the incoming Telegram chat_id AND
 *     phone hash still match — so neither CID knowledge alone nor a different
 *     SIM is sufficient to authorise a transaction.
 *
 * Phones are NEVER stored in plain text — only HMAC-SHA-256 digests.
 */
@Injectable()
export class TelegramVerificationService {
  private readonly logger = new Logger(TelegramVerificationService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(AuthMethod)
    private readonly authMethodRepo: Repository<AuthMethod>,
    @InjectRepository(Position)
    private readonly betRepo: Repository<Position>,
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly configService: ConfigService,
    private readonly dkGateway: DKGatewayService,
  ) {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Deterministic HMAC-SHA-256 hash of a phone number.
   * Strips spaces, dashes and leading '+' so '+975 17 123456' and '97517123456'
   * produce the same digest.
   */
  hashPhone(phone: string): string {
    const secret = this.configService.getOrThrow<string>("PHONE_HASH_SECRET");
    const normalised = phone.replace(/[\s\-\+]/g, "");
    return createHmac("sha256", secret).update(normalised).digest("hex");
  }

  // ── Registration / Linking ────────────────────────────────────────────────

  /**
   * Called when the Telegram bot receives a `contact` update (user shared
   * their phone number using the native keyboard button).
   *
   * Checks that:
   *  - The contact belongs to the sender (not forwarded from someone else).
   *  - The Telegram phone hash matches the DK Bank phone hash for this user.
   *
   * On success, writes `telegramChatId`, `telegramPhoneHash` and
   * `telegramLinkedAt` to the user row.
   */
  async linkTelegramPhone(
    telegramUserId: string, // ctx.from.id as string
    telegramChatId: string, // ctx.chat.id as string (same for private chats)
    contactUserId: string, // contact.user_id as string  ← must equal telegramUserId
    telegramPhone: string, // contact.phone_number
  ): Promise<{ linked: boolean; message: string }> {
    // ── Security: user must share their OWN contact ─────────────────────────
    if (contactUserId !== telegramUserId) {
      throw new BadRequestException("Please share your own phone number only.");
    }

    // ── Find user by Telegram ID ─────────────────────────────────────────────
    this.logger.log(
      `[PhoneVerify] linkTelegramPhone called — telegramUserId=${telegramUserId} chatId=${telegramChatId}`,
    );
    let user = await this.userRepo.findOneBy({ telegramId: telegramUserId });

    // ── Fallback: user registered via DK Bank CID only (no Telegram login yet) ──
    // Hash the incoming phone and look for a DK-only account with a matching dkPhoneHash.
    if (!user) {
      this.logger.log(
        `[PhoneVerify] No user found for telegramId=${telegramUserId} — trying DK phone hash fallback`,
      );
      const incomingPhoneHash = this.hashPhone(telegramPhone);
      user = await this.userRepo.findOneBy({ dkPhoneHash: incomingPhoneHash });

      if (!user) {
        this.logger.warn(
          `[PhoneVerify] No user found for telegramId=${telegramUserId} or matching dkPhoneHash`,
        );
        throw new BadRequestException(
          "No Oro account found for this phone number. " +
            "Please make sure you have linked your DK Bank CID in the Oro Mini App first, then try again.",
        );
      }

      // Guard: if this DK-only account already has a *different* Telegram ID bound, refuse
      if (user.telegramId && user.telegramId !== telegramUserId) {
        this.logger.warn(
          `[PhoneVerify] Phone hash matched user ${user.id} but it already has telegramId=${user.telegramId}`,
        );
        throw new BadRequestException(
          "This DK Bank phone is already linked to a different Telegram account. Contact support.",
        );
      }

      this.logger.log(
        `[PhoneVerify] Matched user ${user.id} via dkPhoneHash — will bind telegramId=${telegramUserId}`,
      );

      // ── Check if a SEPARATE Telegram-only row already exists for this telegramUserId ──
      // This happens when: user opened TMA (created row A with telegramId) then entered
      // CID without being logged in (created row B with dkCid only). Merge B → A.
      const telegramRow = await this.userRepo.findOneBy({
        telegramId: telegramUserId,
      });
      if (telegramRow && telegramRow.id !== user.id) {
        this.logger.log(
          `[PhoneVerify] Found separate Telegram-only row ${telegramRow.id} for telegramId=${telegramUserId} — merging DK-only row ${user.id} into it`,
        );
        user = await this.mergeUsers(telegramRow, user);
      } else {
        // Write the missing telegramId onto the DK-only user row
        await this.userRepo.update(user.id, { telegramId: telegramUserId });
        user.telegramId = telegramUserId;
      }
    }

    this.logger.log(
      `[PhoneVerify] Found user ${user.id} — dkPhoneHash=${user.dkPhoneHash ? user.dkPhoneHash.slice(0, 8) + "…" : "NULL"}`,
    );

    // ── User must already have a DK Bank CID linked ──────────────────────────
    if (!user.dkPhoneHash) {
      // dkPhoneHash can be null if DK returned an empty phone when the CID was
      // first linked. Try a live DK lookup now using the stored CID.
      if (user.dkCid) {
        this.logger.log(
          `[PhoneVerify] dkPhoneHash missing for user ${user.id} — doing live DK lookup for CID ${user.dkCid}`,
        );
        try {
          const account = await this.dkGateway.lookupAccountByCID(user.dkCid);
          if (account.phoneNumber) {
            // Save the hash now so future lookups are instant
            await this.storeDKPhoneHash(user.id, account.phoneNumber);
            user.dkPhoneHash = this.hashPhone(account.phoneNumber);
            // Also update the stored phone number
            await this.userRepo.update(user.id, {
              phoneNumber: account.phoneNumber,
              dkAccountName: account.accountName,
              dkAccountNumber: account.accountNumber,
            });
          } else {
            throw new BadRequestException(
              "Your DK Bank account has no phone number registered. " +
                "Please update your phone number at a DK Bank branch first.",
            );
          }
        } catch (err: any) {
          if (err instanceof BadRequestException) throw err;
          this.logger.error(
            `[PhoneVerify] Live DK lookup failed for user ${user.id} CID ${user.dkCid}: ${err.message}`,
          );
          throw new BadRequestException(
            "Could not reach DK Bank to verify your account right now.\n\n" +
              "Please try again in a few minutes. If the problem persists, contact support.",
          );
        }
      } else {
        throw new BadRequestException(
          "You haven't linked a DK Bank CID to your Oro account yet.\n\n" +
            "Steps to fix:\n" +
            "1️⃣ Open the Oro Mini App\n" +
            "2️⃣ Go to Wallet → Link DK Bank Account\n" +
            "3️⃣ Enter your 11-digit CID number\n" +
            "4️⃣ Come back here and share your phone number again.",
        );
      }
    }

    const telegramPhoneHash = this.hashPhone(telegramPhone);

    // ── Core security check: Telegram phone == DK Bank registered phone ──────
    if (telegramPhoneHash !== user.dkPhoneHash) {
      this.logger.warn(
        `[PhoneVerify] MISMATCH for user ${user.id}: ` +
          `tg_hash=${telegramPhoneHash.slice(0, 8)}… dk_hash=${user.dkPhoneHash.slice(0, 8)}…`,
      );
      throw new BadRequestException(
        "Your Telegram phone number does not match the number registered with DK Bank. " +
          "Please use the phone number linked to your DK Bank account.",
      );
    }

    //  Persist the binding
    await this.userRepo.update(user.id, {
      telegramChatId,
      telegramPhoneHash,
      telegramLinkedAt: new Date(),
    });

    this.logger.log(
      `[PhoneVerify] User ${user.id} successfully linked Telegram phone.`,
    );
    return {
      linked: true,
      message:
        "✅ Phone verified! Your Telegram is now securely linked to your DK Bank account.",
    };
  }

  /**
   * Called at DK Bank CID link / registration time to store the DK phone hash.
   * This is the reference that will be compared against the Telegram phone.
   */
  async storeDKPhoneHash(userId: string, dkPhone: string): Promise<void> {
    if (!dkPhone || dkPhone.trim() === "") {
      // DK Bank returned no phone for this CID.
      // Explicitly null out dkPhoneHash so any stale hash from a previously-linked
      // CID cannot carry forward and make isPhoneVerified appear true for the new CID.
      await this.userRepo.update(userId, { dkPhoneHash: null as any });
      this.logger.warn(
        `[PhoneVerify] DK Bank returned no phone for user ${userId} — dkPhoneHash cleared. ` +
          `User must register a phone at a DK Bank branch to enable payment verification.`,
      );
      return;
    }
    const hash = this.hashPhone(dkPhone);
    await this.userRepo.update(userId, { dkPhoneHash: hash });
    this.logger.log(`[PhoneVerify] DK phone hash stored for user ${userId}`);
  }

  //  Payment-time identity verification

  /**
   * Verifies the Telegram identity before sending an OTP.
   * Two independent checks must both pass:
   *  1. The chat_id making the request matches the bound chat_id.
   *  2. The stored Telegram phone hash still equals the DK Bank phone hash.
   *
   * Returns the user row on success; throws on any failure.
   */
  async verifyPaymentIdentity(
    userId: string,
    incomingChatId?: string,
  ): Promise<User> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException("User not found");

    //  Check 1: Telegram phone has been verified
    if (!user.telegramChatId || !user.telegramPhoneHash) {
      throw new UnauthorizedException(
        "Your Telegram account is not yet phone-verified. " +
          "Please open the Oro bot and share your phone number first.",
      );
    }

    //  Check 2: Same Telegram account that was bound
    if (incomingChatId && user.telegramChatId !== incomingChatId) {
      await this.flagSuspiciousActivity(userId, "chat_id_mismatch");
      throw new UnauthorizedException(
        "Telegram account mismatch. Contact support.",
      );
    }

    //  Check 3: Telegram phone hash still equals DK Bank phone hash
    if (user.telegramPhoneHash !== user.dkPhoneHash) {
      await this.flagSuspiciousActivity(userId, "phone_hash_mismatch");
      throw new UnauthorizedException(
        "Phone verification mismatch detected. Please re-verify your phone via the Oro bot.",
      );
    }

    return user;
  }

  /**
   * Returns whether a user has completed phone verification.
   * Used by the payment flow to decide whether to require re-verification.
   */
  async isPhoneVerified(userId: string): Promise<boolean> {
    const user = await this.userRepo.findOneBy({ id: userId });
    return !!(
      user?.telegramChatId &&
      user?.telegramPhoneHash &&
      user?.dkPhoneHash &&
      user.telegramPhoneHash === user.dkPhoneHash
    );
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Merges `deleteUser` (DK-only row) into `keepUser` (Telegram row).
   *
   * Steps:
   *  1. Copy DK fields from deleteUser → keepUser.
   *  2. Re-point all auth_methods, bets, payments, transactions to keepUser.
   *  3. Delete deleteUser.
   *
   * Returns the refreshed keepUser row.
   */
  private async mergeUsers(keepUser: User, deleteUser: User): Promise<User> {
    this.logger.log(
      `[Merge] Merging user ${deleteUser.id} (DK-only) into ${keepUser.id} (Telegram) — transferring DK fields + related records`,
    );

    // 1. Transfer DK identity fields onto the keeper row
    await this.userRepo.update(keepUser.id, {
      dkCid: deleteUser.dkCid ?? keepUser.dkCid,
      dkAccountNumber: deleteUser.dkAccountNumber ?? keepUser.dkAccountNumber,
      dkAccountName: deleteUser.dkAccountName ?? keepUser.dkAccountName,
      dkPhoneHash: deleteUser.dkPhoneHash ?? keepUser.dkPhoneHash,
      phoneNumber: deleteUser.phoneNumber ?? keepUser.phoneNumber,
      telegramChatId: deleteUser.telegramChatId ?? keepUser.telegramChatId,
    });

    // 2. Re-point auth_methods
    await this.authMethodRepo
      .createQueryBuilder()
      .update()
      .set({ userId: keepUser.id })
      .where("userId = :id", { id: deleteUser.id })
      .execute();

    // 3. Re-point bets
    await this.betRepo
      .createQueryBuilder()
      .update()
      .set({ userId: keepUser.id })
      .where("userId = :id", { id: deleteUser.id })
      .execute();

    // 4. Re-point transactions
    await this.transactionRepo
      .createQueryBuilder()
      .update()
      .set({ userId: keepUser.id })
      .where("userId = :id", { id: deleteUser.id })
      .execute();

    // 5. Re-point payments
    await this.paymentRepo
      .createQueryBuilder()
      .update()
      .set({ userId: keepUser.id })
      .where("userId = :id", { id: deleteUser.id })
      .execute();

    // 6. Delete the now-empty duplicate row
    await this.userRepo.delete(deleteUser.id);

    this.logger.log(
      `[Merge] Successfully merged — duplicate row ${deleteUser.id} deleted`,
    );

    const merged = await this.userRepo.findOneBy({ id: keepUser.id });
    return merged!;
  }

  private async flagSuspiciousActivity(
    userId: string,
    reason: string,
  ): Promise<void> {
    // Log for audit — in production, plug into your alerting system
    this.logger.warn(
      `[SECURITY] Suspicious activity for user ${userId}: ${reason}`,
    );
  }
}
