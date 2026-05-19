import { createHmac, timingSafeEqual, randomUUID, randomInt } from "crypto";
import * as bcrypt from "bcryptjs";
import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { AuthMethod, AuthProvider } from "../entities/auth-method.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";
import { TelegramVerificationService } from "../telegram/telegram-verification.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { AuditService } from "../admin/audit.service";
import { AuditAction, AuditLog, RoleType } from "../entities/audit-log.entity";
import { RedisService } from "../redis/redis.service";

function stripSensitiveFields(
  user: User,
): Omit<
  User,
  "dkPhoneHash" | "telegramPhoneHash" | "phoneNumber" | "pwaPasswordHash"
> {
  const {
    dkPhoneHash: _a,
    telegramPhoneHash: _b,
    phoneNumber: _c,
    pwaPasswordHash: _d,
    ...safe
  } = user as any;
  return safe;
}

export interface TelegramInitData {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(AuthMethod)
    private authMethodRepo: Repository<AuthMethod>,
    @InjectRepository(Transaction)
    private transactionRepo: Repository<Transaction>,
    @InjectRepository(Market) private marketRepo: Repository<Market>,
    @InjectRepository(Position) private positionRepo: Repository<Position>,
    private jwtService: JwtService,
    private dkGateway: DKGatewayService,
    private telegramVerification: TelegramVerificationService,
    private telegramSimple: TelegramSimpleService,
    private auditService: AuditService,
    @InjectRepository(AuditLog) private auditLogRepo: Repository<AuditLog>,
    private redis: RedisService,
  ) {}

  // ── HMAC-SHA-256 Telegram initData validation ──────────────────────────────
  validateTelegramInitData(rawInitData: string): TelegramInitData {
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!botToken) throw new UnauthorizedException("Bot token not configured");
    this.logger.debug(
      `[Auth] Using bot token: id=${botToken.split(":")[0]} len=${botToken.length}`,
    );

    const params = new URLSearchParams(rawInitData);
    const hash = params.get("hash");
    if (!hash) throw new UnauthorizedException("Missing hash in initData");

    // Build data-check string: sorted key=value pairs excluding hash and signature
    params.delete("hash");
    // Note: signature IS included in the data-check string for newer bots
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    // HMAC-SHA-256 with secret_key = HMAC-SHA-256("WebAppData", botToken)
    const secretKey = createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const expectedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedHash);
    const receivedBuf = Buffer.from(hash);
    const hashValid =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);
    if (!hashValid) {
      this.logger.warn(
        `[Auth] initData hash mismatch.\n  Expected : ${expectedHash}\n  Got      : ${hash}\n  dataCheckString:\n${dataCheckString}\n  rawInitData (full): ${rawInitData}`,
      );
      throw new UnauthorizedException("Invalid Telegram initData signature");
    }

    // Check freshness: reject if older than 24h
    const authDate = parseInt(params.get("auth_date") || "0", 10);
    const ageSeconds = Math.floor(Date.now() / 1000 - authDate);
    if (ageSeconds > 86400) {
      this.logger.warn(`[Auth] initData expired — age: ${ageSeconds}s`);
      throw new UnauthorizedException("initData is expired");
    }

    const userJson = params.get("user");
    if (!userJson) throw new UnauthorizedException("Missing user in initData");
    return { ...JSON.parse(userJson), auth_date: authDate, hash };
  }

  // ── Login / Register via Telegram ─────────────────────────────────────────
  async loginWithTelegram(rawInitData: string, referralCode?: string) {
    const tgUser = this.validateTelegramInitData(rawInitData);
    const providerId = String(tgUser.id);

    // Check for existing auth method or user
    const authMethod = await this.authMethodRepo.findOne({
      where: { provider: AuthProvider.TELEGRAM, providerId },
      relations: ["user"],
    });

    const existingUser = authMethod
      ? await this.userRepo.findOneBy({ id: authMethod.user?.id ?? authMethod.userId })
      : await this.userRepo.findOneBy({ telegramId: providerId });

    if (!existingUser) {
      // Brand new user — issue a short-lived pre-KYC token.
      // No DB record is created yet; registration happens via POST /users/telegram/register.
      const token = this.jwtService.sign({
        sub: providerId,
        preKyc: true,
        jti: randomUUID(),
      });
      return {
        token,
        user: null,
        isNewUser: true,
        requiresKYC: true,
        telegramProfile: {
          telegramId: providerId,
          firstName: tgUser.first_name,
          lastName: tgUser.last_name,
          username: tgUser.username,
          photoUrl: tgUser.photo_url,
        },
        referralCode,
      };
    }

    // ── Returning user ────────────────────────────────────────────────────────

    // Resolve referrer for late attribution (user already exists but has no referrer)
    let referredByUserId: string | null = null;
    if (referralCode) {
      const raw = referralCode.startsWith("ref_")
        ? referralCode.slice(4)
        : referralCode;
      const refTelegramId = raw.split("_m_")[0];
      if (refTelegramId && refTelegramId !== providerId) {
        const referrer = await this.userRepo.findOne({
          where: { telegramId: refTelegramId },
          select: ["id"],
        });
        if (referrer) referredByUserId = referrer.id;
      }
    }

    const updateFields: any = {
      telegramId: providerId,
      telegramChatId: providerId,
      firstName: tgUser.first_name,
      lastName: tgUser.last_name,
      photoUrl: tgUser.photo_url,
    };
    if (referredByUserId && !existingUser.referredByUserId) {
      updateFields.referredByUserId = referredByUserId;
    }
    await this.userRepo.update(existingUser.id, updateFields);

    if (!authMethod) {
      await this.authMethodRepo.save(
        this.authMethodRepo.create({
          provider: AuthProvider.TELEGRAM,
          providerId,
          metadata: tgUser,
          user: existingUser,
          userId: existingUser.id,
        }),
      );
    } else {
      await this.authMethodRepo.update(authMethod.id, { metadata: tgUser as any });
    }

    const freshUser = await this.userRepo.findOneBy({ id: existingUser.id });
    const token = this.jwtService.sign({
      sub: freshUser!.id,
      isAdmin: freshUser!.isAdmin,
      jti: randomUUID(),
    });

    await this.auditService.log({
      adminId: freshUser!.id,
      username: freshUser!.username || freshUser!.firstName || "Unknown",
      isAdmin: freshUser!.isAdmin,
      action: AuditAction.USER_LOGIN,
      entityType: "user",
      entityId: freshUser!.id,
      meta: {
        provider: "telegram",
        telegramId: providerId,
        username: freshUser!.username,
      },
    });

    return { token, user: stripSensitiveFields(freshUser!), isNewUser: false, requiresKYC: false };
  }

  // ── First-session welcome DM ──────────────────────────────────────────────
  private async sendWelcomeDM(
    user: User,
    referredByUserId: string | null,
    firstName?: string,
  ): Promise<void> {
    const chatId = Number(user.telegramChatId ?? user.telegramId);
    if (!chatId) return;

    const name = firstName?.trim() || "Predictor";

    // Find the most active open market to show in the welcome message
    const topMarket = await this.marketRepo
      .createQueryBuilder("m")
      .where("m.status = :status", { status: MarketStatus.OPEN })
      .orderBy("m.totalPool", "DESC")
      .limit(1)
      .getOne();

    let msg =
      `🎉 <b>Welcome to Oro, ${name}!</b>\n\n` +
      `You've received <b>Nu 20 free credit</b> — deposit needed to make your first prediction.\n\n`;

    // Fix 3: referral context — show what the referrer is predicting
    if (referredByUserId) {
      const referrer = await this.userRepo.findOne({
        where: { id: referredByUserId },
        select: ["firstName", "username"],
      });

      const referrerPosition = await this.positionRepo
        .createQueryBuilder("p")
        .innerJoinAndSelect("p.market", "m")
        .innerJoinAndSelect("p.outcome", "o")
        .where("p.userId = :uid", { uid: referredByUserId })
        .andWhere("p.status = :ps", { ps: PositionStatus.PENDING })
        .andWhere("m.status = :ms", { ms: MarketStatus.OPEN })
        .orderBy("p.placedAt", "DESC")
        .limit(1)
        .getOne();

      const refName = referrer?.firstName || referrer?.username || "A friend";

      if (referrerPosition) {
        const refMarket = (referrerPosition as any).market;
        const refOutcome = (referrerPosition as any).outcome;
        msg +=
          `👥 <b>${refName}</b> invited you and is predicting <b>${refOutcome?.label}</b> on <b>${refMarket?.title}</b>. ` +
          `Think they're wrong? Take the other side!\n\n`;
      } else {
        msg +=
          `👥 <b>${refName}</b> invited you to Oro. ` +
          `Make your first prediction to earn them a bonus!\n\n`;
      }
    }

    if (topMarket) {
      msg += `🔥 <b>Hot right now:</b> ${topMarket.title}\n\n`;
    }

    msg += `👉 Open Oro to start predicting!`;

    await this.telegramSimple.sendMessage(chatId, msg);
  }

  // ── Admin login — verifies the Telegram account already has isAdmin=true ────
  async ensureAdminAndLogin(rawInitData: string) {
    const result = await this.loginWithTelegram(rawInitData);
    if (!result.user) {
      throw new UnauthorizedException(
        "Admin login requires an existing account. Complete registration first.",
      );
    }
    const userId = result.user.id;
    if (!result.user.isAdmin) {
      // Auto-grant requires an explicit opt-in flag, not just a non-production NODE_ENV.
      // This prevents staging/preview environments from accidentally granting admin to
      // any Telegram user when NODE_ENV is misconfigured or absent.
      if (process.env.ALLOW_AUTO_ADMIN !== "true") {
        throw new UnauthorizedException(
          "This Telegram account does not have admin privileges. Grant isAdmin in the database first.",
        );
      }
      await this.userRepo.update(userId, { isAdmin: true });
    }
    const freshUser = await this.userRepo.findOneBy({ id: userId });
    // freshUser cannot be null — user was just returned by loginWithTelegram
    const token = this.jwtService.sign({
      sub: freshUser!.id,
      isAdmin: freshUser!.isAdmin,
      jti: randomUUID(),
    });
    return { token, user: stripSensitiveFields(freshUser!) };
  }

  // ── Check if a CID account has a PWA password set (no sensitive data) ──────
  async getPwaStatus(cid: string): Promise<{ hasPassword: boolean }> {
    if (!cid || cid.length !== 11) return { hasPassword: false };
    // Per-CID throttle — prevents enumerating which CIDs belong to Oro PWA users
    const { allowed } = await this.redis.rateLimit(`pwa-status:cid:${cid}`, 5, 3600);
    if (!allowed) throw new UnauthorizedException("Too many requests for this CID.");
    const user = await this.userRepo.findOne({
      where: { dkCid: cid },
      select: ["pwaPasswordHash"],
    });
    return { hasPassword: !!user?.pwaPasswordHash };
  }

  // ── Set / Change PWA password (called from TMA, requires valid JWT) ────────
  async setPwaPassword(userId: string, password: string): Promise<void> {
    if (!password || password.length < 6) {
      throw new BadRequestException("Password must be at least 6 characters.");
    }
    const hash = await bcrypt.hash(password, 12);
    await this.userRepo.update(userId, { pwaPasswordHash: hash });
  }

  // ── Login / Register via DK Bank CID ──────────────────────────────────────
  /**
   * Links a DK Bank CID to a Oro account.
   *
   * @param cid - The 11-digit national ID.
   * @param callerUserId - When called from the TMA (already JWT-authenticated),
   *   pass the authenticated user's UUID so the DK fields + dkPhoneHash are
   *   written to that existing Telegram user row instead of creating a new one.
   * @param password - Required when the account has a PWA password set.
   */
  async loginWithDKBank(cid: string, callerUserId?: string, password?: string) {
    const account = await this.dkGateway.lookupAccountByCID(cid);

    // ── If called by an already-authenticated Telegram user, merge into their row ──
    if (callerUserId) {
      const existingUser = await this.userRepo.findOneBy({ id: callerUserId });
      if (existingUser) {
        // ── Step 1: Guard — reject if the CID is already owned by a VERIFIED user ──
        // A fully-verified row (telegramPhoneHash === dkPhoneHash) proves the
        // account holder went through phone verification. Allowing a different
        // user to clobber it would let anyone wipe a verified account just by
        // knowing its CID. Unverified orphans are still cleared (legitimate
        // merge scenario where the same person registers twice).
        const orphanByCid = await this.userRepo.findOneBy({ dkCid: cid });
        if (orphanByCid && orphanByCid.id !== callerUserId) {
          const orphanVerified =
            orphanByCid.telegramPhoneHash &&
            orphanByCid.dkPhoneHash &&
            orphanByCid.telegramPhoneHash === orphanByCid.dkPhoneHash;
          if (orphanVerified) {
            throw new BadRequestException(
              "This CID is already linked to a verified account. " +
                "If this is your CID, please contact support.",
            );
          }
          this.logger.log(
            `[Auth] Clearing unverified orphan ${orphanByCid.id} before linking CID to ${callerUserId}`,
          );
          await this.userRepo.update(orphanByCid.id, {
            dkCid: null as any,
            dkAccountNumber: null as any,
            dkPhoneHash: null as any,
            phoneNumber: null as any,
          });
        }
        const orphanByAccount = await this.userRepo.findOneBy({
          dkAccountNumber: account.accountNumber,
        });
        if (orphanByAccount && orphanByAccount.id !== callerUserId) {
          const orphanAcctVerified =
            orphanByAccount.telegramPhoneHash &&
            orphanByAccount.dkPhoneHash &&
            orphanByAccount.telegramPhoneHash === orphanByAccount.dkPhoneHash;
          if (orphanAcctVerified) {
            throw new BadRequestException(
              "This DK Bank account is already linked to a verified account. " +
                "If this is your account, please contact support.",
            );
          }
          await this.userRepo.update(orphanByAccount.id, {
            dkCid: null as any,
            dkAccountNumber: null as any,
            dkPhoneHash: null as any,
          });
        }

        // ── Step 2: Write DK fields onto the authenticated Telegram user row ──
        // If the CID is changing, clear the phone verification so the user must
        // re-verify against the new CID's DK Bank phone — prevents reusing a
        // previous verification for a different account.
        const cidChanging = existingUser.dkCid !== cid;
        await this.userRepo.update(callerUserId, {
          dkCid: cid,
          dkAccountNumber: account.accountNumber,
          dkAccountName: account.accountName,
          phoneNumber: account.phoneNumber || null,
          ...(cidChanging
            ? {
                telegramPhoneHash: null as any,
                telegramLinkedAt: null as any,
                dkLinkVerifiedAt: null as any,
              }
            : {}),
        });
        // Write dkPhoneHash onto the Telegram user row — this is the key step.
        // storeDKPhoneHash explicitly sets null when DK returns no phone, so a
        // stale hash from a previously-linked CID can never persist.
        await this.telegramVerification.storeDKPhoneHash(
          callerUserId,
          account.phoneNumber,
        );

        // ── Step 3: Upsert the DKBANK auth method — always point it to callerUserId ──
        let dkAuthMethod = await this.authMethodRepo.findOne({
          where: {
            provider: AuthProvider.DKBANK,
            providerId: account.accountNumber,
          },
        });
        if (!dkAuthMethod) {
          dkAuthMethod = this.authMethodRepo.create({
            provider: AuthProvider.DKBANK,
            providerId: account.accountNumber,
            metadata: {
              cid,
              accountName: account.accountName,
            },
            user: existingUser,
            userId: callerUserId,
          });
          await this.authMethodRepo.save(dkAuthMethod);
        } else if (dkAuthMethod.userId !== callerUserId) {
          await this.authMethodRepo.update(dkAuthMethod.id, {
            userId: callerUserId,
          });
          this.logger.log(
            `[Auth] Repointed dkbank auth_method from orphan → ${callerUserId}`,
          );
        }

        const token = this.jwtService.sign({
          sub: existingUser.id,
          isAdmin: existingUser.isAdmin,
          jti: randomUUID(),
        });
        const updatedUser = await this.userRepo.findOneBy({ id: callerUserId });
        const { phoneNumber: _p1, ...safeDkAccount1 } = account;
        return {
          token,
          user: stripSensitiveFields(updatedUser!),
          dkAccount: safeDkAccount1,
        };
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    let authMethod = await this.authMethodRepo.findOne({
      where: {
        provider: AuthProvider.DKBANK,
        providerId: account.accountNumber,
      },
      relations: ["user"],
    });

    if (!authMethod) {
      // Guard: user row may already exist (linked via TMA) but auth_method missing
      let user = await this.userRepo.findOneBy({ dkCid: cid });
      if (!user) {
        user = await this.userRepo.findOneBy({
          dkAccountNumber: account.accountNumber,
        });
      }

      // Telegram user with a matching DK phone may already exist ──
      // This can happen if the Telegram login ran first (creating a row with telegramId
      // but no DK fields) and now the same person enters their CID without a JWT.
      // Hash the DK phone and look for a match so we merge into that row instead of
      // creating a duplicate.
      if (!user && account.phoneNumber) {
        const dkPhoneHash = this.telegramVerification.hashPhone(
          account.phoneNumber,
        );
        user = await this.userRepo.findOneBy({
          telegramPhoneHash: dkPhoneHash,
        });
        if (!user) {
          // Also check if there is a Telegram row whose dkPhoneHash was pre-seeded
          user = await this.userRepo.findOneBy({ dkPhoneHash });
        }
        if (user) {
          this.logger.log(
            `[Auth] Phone-hash match found user ${user.id} — merging DK data instead of creating duplicate`,
          );
        }
      }

      if (user) {
        // User row exists — just ensure fields are up to date and create the missing auth_method
        const cidChangingHere = user.dkCid !== cid;
        await this.userRepo.update(user.id, {
          dkCid: cid,
          dkAccountNumber: account.accountNumber,
          dkAccountName: account.accountName,
          phoneNumber: account.phoneNumber || null,
          ...(cidChangingHere ? { dkLinkVerifiedAt: null as any } : {}),
        });
        await this.telegramVerification.storeDKPhoneHash(
          user.id,
          account.phoneNumber,
        );
        authMethod = this.authMethodRepo.create({
          provider: AuthProvider.DKBANK,
          providerId: account.accountNumber,
          metadata: {
            cid,
            accountName: account.accountName,
            phoneNumber: account.phoneNumber,
          },
          user,
          userId: user.id,
        });
        await this.authMethodRepo.save(authMethod);
        const freshUser = await this.userRepo.findOneBy({ id: user.id });

        // ── PWA password check (same guard as the main path below) ────────────
        if (!callerUserId) {
          if (!freshUser!.pwaPasswordHash) {
            throw new UnauthorizedException(
              "Set a PWA password in Telegram → Settings → Website Access before logging in here.",
            );
          }
          if (!password) {
            throw new UnauthorizedException(
              "This account requires a PWA password.",
            );
          }
          const valid = await bcrypt.compare(
            password,
            freshUser!.pwaPasswordHash,
          );
          if (!valid) {
            throw new UnauthorizedException("Incorrect password.");
          }
        }

        const token = this.jwtService.sign({
          sub: freshUser!.id,
          isAdmin: freshUser!.isAdmin,
          jti: randomUUID(),
        });
        const { phoneNumber: _p2, ...safeDkAccount2 } = account;
        return {
          token,
          user: stripSensitiveFields(freshUser!),
          dkAccount: safeDkAccount2,
        };
      }

      // Brand new user — create account linked to DK Bank identity
      user = this.userRepo.create({
        firstName: account.accountName.split(" ")[0] || account.accountName,
        lastName: account.accountName.split(" ").slice(1).join(" ") || null,
        dkCid: cid,
        dkAccountNumber: account.accountNumber,
        dkAccountName: account.accountName,
        phoneNumber: account.phoneNumber || null,
      });
      await this.userRepo.save(user);

      // Store DK phone hash for future Telegram phone verification
      await this.telegramVerification.storeDKPhoneHash(
        user.id,
        account.phoneNumber,
      );

      // Dev-only seed credits — not available in staging or production
      if (process.env.NODE_ENV === "development") {
        await this.transactionRepo.save(
          this.transactionRepo.create({
            type: TransactionType.DEPOSIT,
            amount: 1000,
            balanceBefore: 0,
            balanceAfter: 1000,
            userId: user.id,
            note: "Starter credits",
          }),
        );
      }

      authMethod = this.authMethodRepo.create({
        provider: AuthProvider.DKBANK,
        providerId: account.accountNumber,
        metadata: {
          cid,
          accountName: account.accountName,
          phoneNumber: account.phoneNumber,
        },
        user,
        userId: user.id,
      });
      await this.authMethodRepo.save(authMethod);
    } else {
      // Existing user — keep DK fields in sync
      await this.userRepo.update(authMethod.userId, {
        dkCid: cid,
        dkAccountNumber: account.accountNumber,
        dkAccountName: account.accountName,
        phoneNumber: account.phoneNumber || null,
      });
      // Re-hash the DK phone in case the registered number changed
      await this.telegramVerification.storeDKPhoneHash(
        authMethod.userId,
        account.phoneNumber,
      );
    }

    const freshUser = await this.userRepo.findOneBy({
      id: authMethod.user?.id ?? authMethod.userId,
    });

    // ── PWA password check ─────────────────────────────────────────────────
    // Only applies when NOT called from TMA (callerUserId absent).
    // A PWA password must be set in Telegram before PWA login is allowed.
    if (!callerUserId) {
      if (!freshUser!.pwaPasswordHash) {
        throw new UnauthorizedException(
          "Set a PWA password in Telegram → Settings → Website Access before logging in here.",
        );
      }
      if (!password) {
        throw new UnauthorizedException(
          "This account requires a PWA password.",
        );
      }
      const valid = await bcrypt.compare(password, freshUser!.pwaPasswordHash);
      if (!valid) {
        throw new UnauthorizedException("Incorrect password.");
      }
    }

    const token = this.jwtService.sign({
      sub: freshUser!.id,
      isAdmin: freshUser!.isAdmin,
      jti: randomUUID(),
    });

    const { phoneNumber: _p3, ...safeDkAccount3 } = account;
    return {
      token,
      user: stripSensitiveFields(freshUser!),
      dkAccount: safeDkAccount3,
    };
  }

  // ── Manual Login (Fallback when Telegram initData fails) ───────────────────

  /**
   * Step 1: Request OTP for manual login
   * Sends a 6-digit OTP to the user's Telegram ID via bot
   */
  async requestManualLoginOtp(telegramId: string, cid: string): Promise<void> {
    // Validate CID with DK Bank first
    const account = await this.dkGateway.lookupAccountByCID(cid);
    if (!account.phoneNumber) {
      throw new UnauthorizedException(
        "DK Bank account has no phone number registered",
      );
    }

    // Generate 6-digit OTP
    const otp = randomInt(100000, 1000000).toString();

    // Store OTP in Redis with 5-minute expiry
    const redisKey = `manual_login_otp:${telegramId}`;
    await this.redis.setJsonEx(redisKey, 300, {
      otp,
      cid,
      dkPhoneHash: this.telegramVerification.hashPhone(account.phoneNumber),
      attempts: 0,
    });

    // Send OTP to user's Telegram
    const message = `🔐 <b>Oro Manual Login</b>\n\nYour OTP: <code>${otp}</code>\n\nValid for 5 minutes. Do not share this code.\n\nIf you didn't request this, ignore this message.`;
    await this.telegramSimple.sendMessage(Number(telegramId), message);

    this.logger.log(`[ManualLogin] OTP sent to Telegram ID ${telegramId}`);
  }

  /**
   * Step 2: Verify OTP and complete manual login
   * Validates OTP and checks phone number matches DK Bank
   */
  async verifyManualLogin(
    telegramId: string,
    cid: string,
    otp: string,
    phoneNumber: string,
  ): Promise<{
    token: string;
    user: Omit<
      User,
      "dkPhoneHash" | "telegramPhoneHash" | "phoneNumber" | "pwaPasswordHash"
    >;
  }> {
    // Retrieve and validate OTP from Redis
    const redisKey = `manual_login_otp:${telegramId}`;
    const stored = await this.redis.getJson<{
      otp: string;
      cid: string;
      dkPhoneHash: string;
      attempts: number;
    }>(redisKey);

    if (!stored) {
      throw new UnauthorizedException(
        "OTP expired or not found. Please request a new OTP.",
      );
    }

    if (stored.cid !== cid) {
      throw new UnauthorizedException(
        "CID mismatch. Please start the login process again.",
      );
    }

    if (stored.otp !== otp) {
      stored.attempts++;
      if (stored.attempts >= 3) {
        await this.redis.del(redisKey);
        throw new UnauthorizedException(
          "Too many failed attempts. Please request a new OTP.",
        );
      }
      await this.redis.setJsonEx(redisKey, 300, {
        ...stored,
        attempts: stored.attempts,
      });
      throw new UnauthorizedException(
        `Invalid OTP. ${3 - stored.attempts} attempts remaining.`,
      );
    }

    // OTP is valid - now verify phone number matches DK Bank
    const providedPhoneHash = this.telegramVerification.hashPhone(phoneNumber);
    if (providedPhoneHash !== stored.dkPhoneHash) {
      await this.redis.del(redisKey);
      throw new UnauthorizedException(
        "Phone number does not match DK Bank registered number. " +
          "Please use the phone number linked to your DK Bank account.",
      );
    }

    // Delete OTP from Redis (one-time use)
    await this.redis.del(redisKey);

    // Find or create user
    let user = await this.userRepo.findOneBy({ telegramId });

    if (!user) {
      // Check if there's an existing DK Bank user with matching phone hash
      user = await this.userRepo.findOneBy({ dkPhoneHash: stored.dkPhoneHash });

      if (user) {
        // Bind Telegram ID to existing DK-only account
        if (user.telegramId && user.telegramId !== telegramId) {
          throw new UnauthorizedException(
            "This DK Bank account is already linked to a different Telegram account.",
          );
        }
        await this.userRepo.update(user.id, { telegramId });
        user.telegramId = telegramId;
      } else {
        // Create new user with Telegram ID
        user = this.userRepo.create({
          telegramId,
          dkCid: cid,
        });
        await this.userRepo.save(user);
      }
    }

    // Ensure DK fields are synced
    const account = await this.dkGateway.lookupAccountByCID(cid);
    const cidChangingManual = user.dkCid !== cid;
    await this.userRepo.update(user.id, {
      dkCid: cid,
      dkAccountNumber: account.accountNumber,
      dkAccountName: account.accountName,
      phoneNumber: account.phoneNumber || null,
      ...(cidChangingManual ? { dkLinkVerifiedAt: null as any } : {}),
    });
    await this.telegramVerification.storeDKPhoneHash(
      user.id,
      account.phoneNumber,
    );

    // Create/update auth method for Telegram
    let tgAuthMethod = await this.authMethodRepo.findOne({
      where: { provider: AuthProvider.TELEGRAM, providerId: telegramId },
      relations: ["user"],
    });

    if (!tgAuthMethod) {
      tgAuthMethod = this.authMethodRepo.create({
        provider: AuthProvider.TELEGRAM,
        providerId: telegramId,
        metadata: { manualLogin: true },
        user,
        userId: user.id,
      });
      await this.authMethodRepo.save(tgAuthMethod);
    }

    // Create/update auth method for DK Bank
    let dkAuthMethod = await this.authMethodRepo.findOne({
      where: {
        provider: AuthProvider.DKBANK,
        providerId: account.accountNumber,
      },
      relations: ["user"],
    });

    if (!dkAuthMethod) {
      dkAuthMethod = this.authMethodRepo.create({
        provider: AuthProvider.DKBANK,
        providerId: account.accountNumber,
        metadata: { cid, accountName: account.accountName },
        user,
        userId: user.id,
      });
      await this.authMethodRepo.save(dkAuthMethod);
    }

    // Store phone hashes for verification
    await this.userRepo.update(user.id, {
      telegramPhoneHash: providedPhoneHash,
      telegramChatId: telegramId,
      telegramLinkedAt: new Date(),
    });

    const freshUser = await this.userRepo.findOneBy({ id: user.id });
    if (!freshUser) {
      throw new UnauthorizedException("User creation failed");
    }

    // Generate JWT
    const token = this.jwtService.sign({
      sub: freshUser.id,
      isAdmin: freshUser.isAdmin,
      jti: randomUUID(),
    });

    // Log the login
    await this.auditService.log({
      adminId: freshUser.id,
      username: freshUser.username || freshUser.firstName || telegramId,
      isAdmin: freshUser.isAdmin,
      action: AuditAction.USER_LOGIN,
      entityType: "user",
      entityId: freshUser.id,
      meta: {
        provider: "manual",
        telegramId,
        cid,
      },
    });

    this.logger.log(
      `[ManualLogin] User ${freshUser.id} logged in successfully via manual flow`,
    );

    return { token, user: stripSensitiveFields(freshUser) };
  }

  // ── JWT revocation ────────────────────────────────────────────────────────
  async revokeToken(jti: string, exp: number, userId: string): Promise<void> {
    const ttl = exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) {
      await this.redis.setEx(`jwt:blacklist:${jti}`, ttl, "1");
    }
    await this.auditLogRepo.save(
      this.auditLogRepo.create({
        adminId: userId,
        username: "system",
        roleType: RoleType.USER,
        action: AuditAction.AUTH_TOKEN_REVOKED,
        entityType: "user",
        entityId: userId,
        payload: { meta: { jti } },
      }),
    );
  }

  // ── Auth failure tracking ─────────────────────────────────────────────────
  async recordAuthFailure(
    action: AuditAction,
    cid: string,
    ip: string,
  ): Promise<void> {
    const key = `auth:fail:${cid}`;
    try {
      const count = await this.redis.redis.incr(key);
      // Set 15-minute expiry on first increment
      if (count === 1) await this.redis.redis.expire(key, 900);
      if (count >= 5) {
        this.logger.warn(
          `[Security] ${count} failed auth attempts for CID ${cid} from IP ${ip}`,
        );
      }
    } catch {
      // Redis unavailable — still log to DB
    }
    try {
      await this.auditLogRepo.save(
        this.auditLogRepo.create({
          adminId: "anonymous",
          username: cid,
          roleType: RoleType.USER,
          action,
          entityType: "user",
          entityId: cid,
          payload: { meta: { ip, cid } },
        }),
      );
    } catch {
      // Non-fatal — don't break auth flow
    }
  }
}
