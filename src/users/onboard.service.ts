import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { randomInt, randomUUID } from "crypto";
import { IsNull, Repository } from "typeorm";
import { AuthMethod, AuthProvider } from "../entities/auth-method.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { User } from "../entities/user.entity";
import { RedisService } from "../redis/redis.service";
import { SmsService } from "../shared/services/sms.service";
import { EmailService } from "../shared/services/email.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { TelegramVerificationService } from "../telegram/telegram-verification.service";

interface RegisterDto {
  username: string;
  fullName: string;
  otp: string;
  phoneNumber?: string;
  email?: string;
  referralCode?: string;
  photoUrl?: string;
}

@Injectable()
export class OnboardService {
  private readonly logger = new Logger(OnboardService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(AuthMethod)
    private readonly authMethodRepo: Repository<AuthMethod>,
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
    private readonly redis: RedisService,
    private readonly smsService: SmsService,
    private readonly emailService: EmailService,
    private readonly telegramSimple: TelegramSimpleService,
    private readonly jwtService: JwtService,
    private readonly telegramVerification: TelegramVerificationService,
  ) {}

  async isUsernameAvailable(username: string): Promise<boolean> {
    const lower = username.toLowerCase();
    const existing = await this.userRepo.findOne({
      where: { username: lower },
      select: ["id"],
    });
    return !existing;
  }

  async sendOnboardOtp(
    telegramId: string,
    phone?: string,
    email?: string,
  ): Promise<void> {
    const otp = randomInt(100000, 1000000).toString();
    const redisKey = `onboard_otp:${telegramId}`;

    await this.redis.setJsonEx(redisKey, 300, {
      otp,
      phone: phone ?? null,
      email: email ?? null,
      attempts: 0,
    });

    if (phone) {
      const sent = await this.smsService.sendOtp(phone, otp);
      if (!sent)
        this.logger.warn(
          `[Onboard] SMS delivery failed for ${phone}, falling back to Telegram`,
        );
      else {
        this.logger.log(`[Onboard] OTP sent via SMS to ${phone}`);
        return;
      }
    }

    if (email) {
      const sent = await this.emailService.sendOtp(email, otp);
      if (!sent)
        this.logger.warn(
          `[Onboard] Email delivery failed for ${email}, falling back to Telegram`,
        );
      else {
        this.logger.log(`[Onboard] OTP sent via email to ${email}`);
        return;
      }
    }

    // Fallback: deliver via Telegram DM if SMS/email unavailable or disabled
    const target = phone ?? email ?? "unknown";
    const message =
      `🔐 <b>Oro Verification</b>\n\n` +
      `Your code: <code>${otp}</code>\n\n` +
      `Verifying account for ${target}.\n` +
      `Valid for 5 minutes. Do not share this code.`;
    await this.telegramSimple.sendMessage(Number(telegramId), message);
    this.logger.log(
      `[Onboard] OTP sent via Telegram fallback to ${telegramId}`,
    );
  }

  private async verifyOtp(telegramId: string, otp: string): Promise<void> {
    const redisKey = `onboard_otp:${telegramId}`;
    const stored = await this.redis.getJson<{
      otp: string;
      phone: string | null;
      email: string | null;
      attempts: number;
    }>(redisKey);

    if (!stored) {
      throw new UnauthorizedException(
        "Code expired or not found. Please request a new code.",
      );
    }

    this.logger.debug(
      `[OTP] stored="${stored.otp}" (len=${String(stored.otp).length}) received="${otp}" (len=${String(otp).length})`,
    );

    if (String(stored.otp).trim() !== String(otp).trim()) {
      stored.attempts++;
      if (stored.attempts >= 3) {
        await this.redis.del(redisKey);
        throw new UnauthorizedException(
          "Too many incorrect attempts. Please restart registration.",
        );
      }
      await this.redis.setJsonEx(redisKey, 300, stored);
      const remaining = 3 - stored.attempts;
      throw new UnauthorizedException(
        `Invalid code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`,
      );
    }

    await this.redis.del(redisKey);
  }

  async registerTelegramUser(
    telegramId: string,
    dto: RegisterDto,
  ): Promise<{ token: string; user: User }> {
    await this.verifyOtp(telegramId, dto.otp);

    const lower = dto.username.toLowerCase();

    // Race-condition guard: user may have been created by a concurrent request
    const already = await this.userRepo.findOneBy({ telegramId });
    if (already) {
      const token = this.jwtService.sign({
        sub: already.id,
        isAdmin: already.isAdmin,
        jti: randomUUID(),
      });
      return { token, user: already };
    }

    // ── Look for an existing PWA-only user (BhutanApp-created) to merge into ──
    // Matches by phone (exact + hashed) or email. Only candidates with no
    // telegramId yet — verified TMA accounts are never silently absorbed.
    let existingPwa: User | null = null;
    if (dto.phoneNumber) {
      const phoneHash = this.telegramVerification.hashPhone(dto.phoneNumber);
      existingPwa = await this.userRepo.findOne({
        where: [
          { phoneNumber: dto.phoneNumber, telegramId: IsNull() },
          { dkPhoneHash: phoneHash, telegramId: IsNull() },
          { telegramPhoneHash: phoneHash, telegramId: IsNull() },
        ],
      });
    }
    if (!existingPwa && dto.email) {
      existingPwa = await this.userRepo.findOne({
        where: { email: dto.email.toLowerCase(), telegramId: IsNull() },
      });
    }

    // Username availability — allow the matched PWA user to keep / take their own
    const usernameOwner = await this.userRepo.findOne({
      where: { username: lower },
      select: ["id"],
    });
    if (
      usernameOwner &&
      (!existingPwa || usernameOwner.id !== existingPwa.id)
    ) {
      throw new BadRequestException("Username is already taken.");
    }

    // Resolve referrer
    let referredByUserId: string | null = null;
    if (dto.referralCode) {
      const raw = dto.referralCode.startsWith("ref_")
        ? dto.referralCode.slice(4)
        : dto.referralCode;
      const refTelegramId = raw.split("_m_")[0];
      if (refTelegramId && refTelegramId !== telegramId) {
        const referrer = await this.userRepo.findOne({
          where: { telegramId: refTelegramId },
          select: ["id"],
        });
        if (referrer) referredByUserId = referrer.id;
      }
    }

    const nameParts = dto.fullName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ") || null;

    // ── MERGE PATH: attach Telegram identity to existing PWA user ─────────────
    if (existingPwa) {
      const phoneHash = dto.phoneNumber
        ? this.telegramVerification.hashPhone(dto.phoneNumber)
        : null;

      await this.userRepo.update(existingPwa.id, {
        telegramId,
        telegramChatId: telegramId,
        username: lower,
        firstName,
        lastName,
        phoneNumber: dto.phoneNumber ?? existingPwa.phoneNumber,
        email: dto.email ?? existingPwa.email,
        photoUrl: dto.photoUrl ?? existingPwa.photoUrl,
        ...(existingPwa.referredByUserId ? {} : { referredByUserId }),
        ...(phoneHash ? { telegramPhoneHash: phoneHash } : {}),
        // Backfill starter reputation if missing — PWA users created before
        // we set this explicitly may have null here.
        ...(existingPwa.reputationScore == null
          ? { reputationScore: 0.5 }
          : {}),
        telegramLinkedAt: new Date(),
      });

      await this.authMethodRepo.save(
        this.authMethodRepo.create({
          provider: AuthProvider.TELEGRAM,
          providerId: telegramId,
          metadata: { mergedFromPwa: true },
          user: existingPwa,
          userId: existingPwa.id,
        }),
      );

      this.logger.log(
        `[Onboard] Merged Telegram identity into existing PWA user ${existingPwa.id} (tg: ${telegramId})`,
      );

      const fresh = await this.userRepo.findOneBy({ id: existingPwa.id });
      const token = this.jwtService.sign({
        sub: fresh!.id,
        isAdmin: fresh!.isAdmin,
        jti: randomUUID(),
      });
      return { token, user: fresh! };
    }

    // ── CREATE PATH: brand new user ───────────────────────────────────────────
    const user = this.userRepo.create({
      telegramId,
      telegramChatId: telegramId,
      username: lower,
      firstName,
      lastName,
      phoneNumber: dto.phoneNumber ?? null,
      email: dto.email ?? null,
      photoUrl: dto.photoUrl ?? null,
      referredByUserId,
      reputationScore: 0.5,
    });
    await this.userRepo.save(user);

    // Grant one-time 20 Nu welcome free credit — atomic guard prevents double-grant
    const creditClaim = await this.userRepo.update(
      { id: user.id, freeCreditGranted: false },
      { freeCreditGranted: true },
    );
    if (creditClaim.affected) {
      await this.transactionRepo.save(
        this.transactionRepo.create({
          type: TransactionType.FREE_CREDIT,
          amount: 20,
          balanceBefore: 0,
          balanceAfter: 20,
          userId: user.id,
          isBonus: true,
          note: "Welcome free credit",
        }),
      );
    }

    // Create Telegram auth method
    await this.authMethodRepo.save(
      this.authMethodRepo.create({
        provider: AuthProvider.TELEGRAM,
        providerId: telegramId,
        metadata: { registeredViaOnboarding: true },
        user,
        userId: user.id,
      }),
    );

    if (process.env.NODE_ENV === "development") {
      await this.transactionRepo.save(
        this.transactionRepo.create({
          type: TransactionType.DEPOSIT,
          amount: 1000,
          balanceBefore: 20,
          balanceAfter: 1020,
          userId: user.id,
          note: "Starter credits (dev only)",
        }),
      );
    }

    this.logger.log(
      `[Onboard] User registered: ${user.id} (tg: ${telegramId})`,
    );

    const token = this.jwtService.sign({
      sub: user.id,
      isAdmin: user.isAdmin,
      jti: randomUUID(),
    });

    return { token, user };
  }
}
