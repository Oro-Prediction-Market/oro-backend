import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomInt } from "crypto";
import { Repository } from "typeorm";

import { LinkedBankAccount } from "../entities/linked-bank-account.entity";
import { User } from "../entities/user.entity";
import { RedisService } from "../redis/redis.service";
import { SmsService } from "../shared/services/sms.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { TelegramVerificationService } from "../telegram/telegram-verification.service";
import { DKGatewayService } from "./services/dk-gateway/dk-gateway.service";

const OTP_TTL_SEC = 300; // 5 minutes
const MAX_ATTEMPTS = 3;

interface OtpSession {
  otp: string;
  accountId: string;
  attempts: number;
}

@Injectable()
export class BankLinkService {
  private readonly logger = new Logger(BankLinkService.name);

  constructor(
    @InjectRepository(LinkedBankAccount)
    private readonly lbaRepo: Repository<LinkedBankAccount>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dkGateway: DKGatewayService,
    private readonly redis: RedisService,
    private readonly smsService: SmsService,
    private readonly telegramSimple: TelegramSimpleService,
    private readonly telegramVerification: TelegramVerificationService,
  ) {}

  async linkBankAccount(
    userId: string,
    cid: string,
    expectedPhone?: string,
  ): Promise<{
    accountName: string;
    maskedPhone: string;
    requiresOtp: boolean;
  }> {
    const cleanCid = cid.trim().replace(/\D/g, "");
    if (cleanCid.length < 11) {
      throw new BadRequestException("CID must be 11 digits");
    }

    // Check if this CID is already verified and linked to a DIFFERENT user
    const cidConflict = await this.lbaRepo.findOne({
      where: { cid: cleanCid, isVerified: true },
      select: ["id", "userId"],
    });
    if (cidConflict && cidConflict.userId !== userId) {
      throw new ConflictException(
        "This CID is already linked to another account.",
      );
    }

    // Look up the DK Bank account
    let accountNumber: string;
    let accountName: string;
    let bankPhone: string;
    try {
      const result = await this.dkGateway.lookupAccountByCID(cleanCid);
      accountNumber = result.accountNumber;
      accountName = result.accountName;
      bankPhone = result.phoneNumber;
    } catch (e: any) {
      throw new BadRequestException(
        e?.message || "Could not find a DK Bank account for this CID.",
      );
    }

    if (!bankPhone) {
      throw new BadRequestException(
        "No phone number registered with this DK Bank account. Please visit a DK Bank branch.",
      );
    }

    this.logger.log(
      `[BankLink] CID=${cleanCid} → accountName="${accountName}", bankPhone="${bankPhone}", accountNumber="${accountNumber}"`,
    );

    // If expectedPhone is provided (from onboarding), verify it matches DK Bank's phone
    if (expectedPhone) {
      const normalizedExpected = this.stripToLocal(expectedPhone);
      const normalizedBank = this.stripToLocal(bankPhone);
      this.logger.log(
        `[BankLink] Phone match check: user="${normalizedExpected}" vs DK="${normalizedBank}"`,
      );
      if (normalizedExpected !== normalizedBank) {
        throw new BadRequestException(
          `Phone number mismatch. The phone number registered with your DK Bank account does not match the phone you provided. DK Bank has: ${this.maskPhone(bankPhone)}`,
        );
      }
    }

    // Upsert: reuse existing unverified record for this user/cid, or create new
    let account = await this.lbaRepo.findOne({
      where: { userId, cid: cleanCid },
    });

    if (account && account.isVerified) {
      // Re-linking an already-verified account — re-verify to confirm ownership
      account.isVerified = false;
      account.verifiedAt = null;
    }

    if (!account) {
      account = this.lbaRepo.create({ userId, cid: cleanCid });
    }

    account.accountNumber = accountNumber;
    account.accountName = accountName;
    account.bankPhone = bankPhone;
    account.linkAttempts = 0;
    await this.lbaRepo.save(account);



    // Generate and send OTP to the DK-registered phone
    const otp = randomInt(100000, 1000000).toString();
    await this.redis.setJsonEx<OtpSession>(
      `bank_link_otp:${userId}`,
      OTP_TTL_SEC,
      { otp, accountId: account.id, attempts: 0 },
    );

    // Normalize phone: DK gateway may return local number (e.g. "17123456")
    // The SMS gateway needs the full international format with country code
    const normalizedPhone = this.normalizePhone(bankPhone);
    this.logger.log(
      `[BankLink] Sending OTP to phone: raw="${bankPhone}" normalized="${normalizedPhone}"`,
    );

    const sent = await this.smsService.sendOtp(normalizedPhone, otp);
    if (!sent) {
      // Telegram fallback
      const user = await this.userRepo.findOne({
        where: { id: userId },
        select: ["telegramId", "firstName"],
      });
      if (user?.telegramId) {
        await this.telegramSimple
          .sendMessage(
            Number(user.telegramId),
            `🔐 <b>Oro Bank Linking</b>\n\n` +
              `Your verification code: <code>${otp}</code>\n\n` +
              `Enter this code to link your DK Bank account.\n` +
              `Valid for 5 minutes. Do not share this code.`,
          )
          .catch((err) =>
            this.logger.warn(
              `Telegram bank-link OTP fallback failed: ${err.message}`,
            ),
          );
      }
      this.logger.warn(
        `[BankLink] SMS failed for ${bankPhone}, sent via Telegram fallback`,
      );
    } else {
      this.logger.log(
        `[BankLink] OTP sent via SMS to ${this.maskPhone(bankPhone)}`,
      );
    }

    return {
      accountName,
      maskedPhone: this.maskPhone(bankPhone),
      requiresOtp: true,
    };
  }

  async verifyBankLink(
    userId: string,
    otp: string,
  ): Promise<LinkedBankAccount> {
    const session = await this.redis.getJson<OtpSession>(
      `bank_link_otp:${userId}`,
    );

    if (!session) {
      throw new UnauthorizedException(
        "Code expired or not found. Please restart bank account linking.",
      );
    }

    if (String(session.otp).trim() !== String(otp).trim()) {
      session.attempts++;
      if (session.attempts >= MAX_ATTEMPTS) {
        await this.redis.del(`bank_link_otp:${userId}`);
        throw new UnauthorizedException(
          "Too many incorrect attempts. Please restart bank account linking.",
        );
      }
      await this.redis.setJsonEx(
        `bank_link_otp:${userId}`,
        OTP_TTL_SEC,
        session,
      );
      const remaining = MAX_ATTEMPTS - session.attempts;
      throw new UnauthorizedException(
        `Invalid code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`,
      );
    }

    await this.redis.del(`bank_link_otp:${userId}`);

    const account = await this.lbaRepo.findOne({
      where: { id: session.accountId, userId },
    });
    if (!account) {
      throw new NotFoundException("Bank account record not found.");
    }

    // Unset isDefault on all other accounts for this user before setting new default
    await this.lbaRepo
      .createQueryBuilder()
      .update()
      .set({ isDefault: false })
      .where(`"userId" = :userId AND "id" != :id`, {
        userId,
        id: account.id,
      })
      .execute();

    account.isVerified = true;
    account.isDefault = true;
    account.verifiedAt = new Date();
    await this.lbaRepo.save(account);

    // Sync DK fields back to users table for backward compatibility (admin panel, etc.)
    await this.userRepo.update(userId, {
      dkCid: account.cid,
      dkAccountNumber: account.accountNumber,
      dkAccountName: account.accountName,
      dkLinkVerifiedAt: account.verifiedAt,
    });

    this.logger.log(
      `[BankLink] Account ${account.id} verified for user ${userId} (CID: ${account.cid})`,
    );

    return account;
  }

  async getLinkedAccounts(userId: string): Promise<LinkedBankAccount[]> {
    return this.lbaRepo.find({
      where: { userId, isVerified: true },
      order: { isDefault: "DESC", createdAt: "DESC" },
    });
  }

  async getDefaultAccount(userId: string): Promise<LinkedBankAccount | null> {
    return this.lbaRepo.findOne({
      where: { userId, isVerified: true, isDefault: true },
    });
  }

  async unlinkAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.lbaRepo.findOne({
      where: { id: accountId, userId },
    });
    if (!account) throw new NotFoundException("Linked account not found.");
    await this.lbaRepo.remove(account);
  }

  /**
   * Normalize a phone number to international format for the SMS gateway.
   * DK gateway often returns local Bhutanese numbers (e.g. "17123456")
   * without the +975 country code prefix.
   */
  private normalizePhone(phone: string): string {
    let cleaned = phone.replace(/[\s\-()]/g, "");

    // Already has + prefix — return as-is
    if (cleaned.startsWith("+")) return cleaned;

    // Already has 975 country code without +
    if (cleaned.startsWith("975") && cleaned.length >= 11) {
      return `+${cleaned}`;
    }

    // Local Bhutanese number (starts with 17, 77, 16, etc.) — prepend +975
    if (cleaned.length === 8 && /^[1-9]/.test(cleaned)) {
      return `+975${cleaned}`;
    }

    // Fallback: assume Bhutan if 8 digits or less
    if (cleaned.length <= 8) {
      return `+975${cleaned}`;
    }

    // Otherwise return with + prefix (assume it's already an international number)
    return `+${cleaned}`;
  }

  private maskPhone(phone: string): string {
    if (phone.length <= 4) return "****";
    return phone.slice(0, -4).replace(/\d/g, "*") + phone.slice(-4);
  }

  /**
   * Strip a phone number down to the local 8-digit Bhutanese number for comparison.
   * E.g. "+97517123456" → "17123456", "97517123456" → "17123456", "17123456" → "17123456"
   */
  private stripToLocal(phone: string): string {
    let cleaned = phone.replace(/[\s\-()+ ]/g, "");
    // Remove country code 975
    if (cleaned.startsWith("975") && cleaned.length === 11) {
      cleaned = cleaned.substring(3);
    }
    return cleaned;
  }
}
