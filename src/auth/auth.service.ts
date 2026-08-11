import { createHmac, timingSafeEqual, randomUUID, randomInt } from "crypto";
import * as jwt from "jsonwebtoken";
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
import { SmsService } from "../shared/services/sms.service";

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
  /**
   * Deep-link start param carried inside the signed initData when the Mini App
   * is opened via `t.me/<bot>?startapp=<param>`. Used as the authoritative
   * source for referral attribution — independent of any frontend capture.
   */
  start_param?: string;
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
    private smsService: SmsService,
  ) {}

  // ── HMAC-SHA-256 Telegram initData validation ──────────────────────────────
  validateTelegramInitData(rawInitData: string): TelegramInitData {
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!botToken) throw new UnauthorizedException("Bot token not configured");
    // Log only the public bot id (before the ":"), never the token length or
    // the secret half — the secret must never reach log storage.
    this.logger.debug(`[Auth] Using bot id=${botToken.split(":")[0]}`);

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
      // Do NOT log rawInitData / dataCheckString — they carry the user's Telegram
      // profile (id, name, username). A generic warning is enough to notice
      // problems without writing personal data to the logs.
      this.logger.warn("[Auth] initData signature check failed");
      throw new UnauthorizedException("Invalid Telegram initData signature");
    }

    // Check freshness. Reject anything older than 24h, and — just as important —
    // anything dated in the FUTURE (beyond a small clock-skew tolerance). A
    // future auth_date produces a negative "age" that would otherwise sail past
    // the max-age check and effectively never expire.
    const MAX_AGE_SECONDS = 86400; // 24h
    const CLOCK_SKEW_SECONDS = 300; // tolerate 5 min of clock drift
    const authDate = parseInt(params.get("auth_date") || "0", 10);
    const ageSeconds = Math.floor(Date.now() / 1000 - authDate);
    if (ageSeconds > MAX_AGE_SECONDS) {
      this.logger.warn(`[Auth] initData expired — age: ${ageSeconds}s`);
      throw new UnauthorizedException("initData is expired");
    }
    if (ageSeconds < -CLOCK_SKEW_SECONDS) {
      this.logger.warn(
        `[Auth] initData rejected — auth_date is in the future (age: ${ageSeconds}s)`,
      );
      throw new UnauthorizedException("initData timestamp is invalid");
    }

    const userJson = params.get("user");
    if (!userJson) throw new UnauthorizedException("Missing user in initData");
    return {
      ...JSON.parse(userJson),
      auth_date: authDate,
      hash,
      start_param: params.get("start_param") ?? undefined,
    };
  }

  /**
   * Telegram Mini App initData usually carries only a generated ".svg"
   * placeholder avatar in `photo_url` — not the user's real photo. Treat any
   * `.svg` URL as "no real photo" so we fall back to the Bot API, which returns
   * a real, CORS-enabled `api.telegram.org/file/*.jpg` the share card can draw.
   */
  private isRealPhoto(url?: string | null): boolean {
    return !!url && !/\.svg(\?|$)/i.test(url);
  }

  // ── Login / Register via Telegram ─────────────────────────────────────────
  async loginWithTelegram(rawInitData: string, referralCode?: string) {
    const tgUser = this.validateTelegramInitData(rawInitData);
    const providerId = String(tgUser.id);

    // Prefer the referral code the frontend forwarded, but fall back to the
    // start_param embedded in the signed initData. The latter is authoritative
    // and immune to frontend capture bugs / cold-launch timing.
    const initDataStartParam = tgUser.start_param?.startsWith("ref_")
      ? tgUser.start_param
      : undefined;
    const effectiveReferralCode = referralCode ?? initDataStartParam;

    // Check for existing auth method or user
    const authMethod = await this.authMethodRepo.findOne({
      where: { provider: AuthProvider.TELEGRAM, providerId },
      relations: ["user"],
    });

    const existingUser = authMethod
      ? await this.userRepo.findOneBy({
          id: authMethod.user?.id ?? authMethod.userId,
        })
      : await this.userRepo.findOneBy({ telegramId: providerId });

    if (!existingUser) {
      // Brand new user — issue a short-lived pre-KYC token.
      // No DB record is created yet; registration happens via POST /users/telegram/register.
      const token = this.jwtService.sign({
        sub: providerId,
        preKyc: true,
        jti: randomUUID(),
      });

      // Prefer a real photo. initData's photo_url is usually just a ".svg"
      // placeholder, so fall back to the Bot API (real, CORS-enabled .jpg) and
      // only keep the placeholder if nothing better is available.
      let photoUrl = this.isRealPhoto(tgUser.photo_url)
        ? tgUser.photo_url
        : null;
      if (!photoUrl) {
        photoUrl =
          (await this.telegramSimple
            .getUserProfilePhotoUrl(Number(providerId))
            .catch(() => null)) ||
          tgUser.photo_url ||
          null;
      }

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
          photoUrl,
        },
        referralCode: effectiveReferralCode,
      };
    }

    // ── Returning user ────────────────────────────────────────────────────────

    // Resolve referrer for late attribution (user already exists but has no referrer)
    let referredByUserId: string | null = null;
    if (effectiveReferralCode) {
      const raw = effectiveReferralCode.startsWith("ref_")
        ? effectiveReferralCode.slice(4)
        : effectiveReferralCode;
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
    };

    // Resolve the best avatar. initData's photo_url is usually a generated
    // ".svg" placeholder, so treat that as "no photo" and fall back to the Bot
    // API (real, CORS-enabled .jpg the share card can draw). Never clobber an
    // already-resolved real photo with a placeholder, and only hit the Bot API
    // when we don't already have a real photo stored.
    if (this.isRealPhoto(tgUser.photo_url)) {
      updateFields.photoUrl = tgUser.photo_url;
    } else if (this.isRealPhoto(existingUser.photoUrl)) {
      // Keep the real photo resolved on a previous login — no API call needed.
    } else {
      const fetched = await this.telegramSimple
        .getUserProfilePhotoUrl(Number(providerId))
        .catch(() => null);
      if (fetched) {
        updateFields.photoUrl = fetched;
      } else if (!existingUser.photoUrl && tgUser.photo_url) {
        // Nothing better available — a placeholder beats no avatar at all.
        updateFields.photoUrl = tgUser.photo_url;
      }
      // else: keep whatever exists; never overwrite with a placeholder/null.
    }

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
      await this.authMethodRepo.update(authMethod.id, {
        metadata: tgUser as any,
      });
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

    return {
      token,
      user: stripSensitiveFields(freshUser!),
      isNewUser: false,
      requiresKYC: false,
    };
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
      `Deposit to your Oro wallet to start making predictions and win real BTN.\n\n`;

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
    const { allowed } = await this.redis.rateLimit(
      `pwa-status:cid:${cid}`,
      5,
      3600,
    );
    if (!allowed)
      throw new UnauthorizedException("Too many requests for this CID.");
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
  async loginWithDKBank(cid: string, callerUserId?: string, password?: string, referralCode?: string) {
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
        // Track orphans already drained, in case orphanByCid and orphanByAccount
        // resolve to the same row (a common case — same user, both fields set).
        const drained = new Set<string>();

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
          await this.transferOrphanBalance(orphanByCid.id, callerUserId);
          drained.add(orphanByCid.id);
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
          if (!drained.has(orphanByAccount.id)) {
            await this.transferOrphanBalance(orphanByAccount.id, callerUserId);
            drained.add(orphanByAccount.id);
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
        const earlyPathRef: Record<string, any> = {};
        if (referralCode && !user.referredByUserId) {
          const raw = referralCode.startsWith("ref_") ? referralCode.slice(4) : referralCode;
          const refTelegramId = raw.split("_m_")[0];
          if (refTelegramId) {
            const referrer = await this.userRepo.findOne({
              where: { telegramId: refTelegramId },
              select: ["id"],
            });
            if (referrer) earlyPathRef.referredByUserId = referrer.id;
          }
        }
        await this.userRepo.update(user.id, {
          dkCid: cid,
          dkAccountNumber: account.accountNumber,
          dkAccountName: account.accountName,
          phoneNumber: account.phoneNumber || null,
          ...(cidChangingHere ? { dkLinkVerifiedAt: null as any } : {}),
          ...earlyPathRef,
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
      let newUserReferredByUserId: string | null = null;
      if (referralCode) {
        const raw = referralCode.startsWith("ref_") ? referralCode.slice(4) : referralCode;
        const refTelegramId = raw.split("_m_")[0];
        if (refTelegramId) {
          const referrer = await this.userRepo.findOne({
            where: { telegramId: refTelegramId },
            select: ["id"],
          });
          if (referrer) newUserReferredByUserId = referrer.id;
        }
      }
      user = this.userRepo.create({
        firstName: account.accountName.split(" ")[0] || account.accountName,
        lastName: account.accountName.split(" ").slice(1).join(" ") || null,
        dkCid: cid,
        dkAccountNumber: account.accountNumber,
        dkAccountName: account.accountName,
        phoneNumber: account.phoneNumber || null,
        referredByUserId: newUserReferredByUserId,
      });
      await this.userRepo.save(user);

      // Store DK phone hash for future Telegram phone verification
      await this.telegramVerification.storeDKPhoneHash(
        user.id,
        account.phoneNumber,
      );

      // Welcome free credit disabled — no longer granting Nu 20 on signup/login.
      // Kept for reference in case the promotion is re-enabled.
      // const creditClaim = await this.userRepo.update(
      //   { id: user.id, freeCreditGranted: false },
      //   { freeCreditGranted: true },
      // );
      // if (creditClaim.affected) {
      //   await this.transactionRepo.save(
      //     this.transactionRepo.create({
      //       type: TransactionType.FREE_CREDIT,
      //       amount: 20,
      //       balanceBefore: 0,
      //       balanceAfter: 20,
      //       userId: user.id,
      //       isBonus: true,
      //       note: "Welcome free credit",
      //     }),
      //   );
      // }

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
      const existingForRef = await this.userRepo.findOneBy({ id: authMethod.userId });
      const dkLateRef: Record<string, any> = {};
      if (referralCode && existingForRef && !existingForRef.referredByUserId) {
        const raw = referralCode.startsWith("ref_") ? referralCode.slice(4) : referralCode;
        const refTelegramId = raw.split("_m_")[0];
        if (refTelegramId) {
          const referrer = await this.userRepo.findOne({
            where: { telegramId: refTelegramId },
            select: ["id"],
          });
          if (referrer) dkLateRef.referredByUserId = referrer.id;
        }
      }
      await this.userRepo.update(authMethod.userId, {
        dkCid: cid,
        dkAccountNumber: account.accountNumber,
        dkAccountName: account.accountName,
        phoneNumber: account.phoneNumber || null,
        ...dkLateRef,
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
  async getUserFromToken(token: string) {
    let payload: { sub?: string; jti?: string };
    try {
      payload = this.jwtService.verify(token) as typeof payload;
    } catch {
      throw new UnauthorizedException("Invalid or expired session");
    }
    if (!payload.sub) throw new UnauthorizedException("Invalid token payload");

    const isBlacklisted = payload.jti
      ? await this.redis.get(`jwt:blacklist:${payload.jti}`)
      : null;
    if (isBlacklisted) throw new UnauthorizedException("Session has been revoked");

    const user = await this.userRepo.findOneBy({ id: payload.sub });
    if (!user) throw new UnauthorizedException("User not found");
    return stripSensitiveFields(user);
  }

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

  // ── BhutanApp OAuth ───────────────────────────────────────────────────────
  /**
   * Login or register via BhutanApp OAuth.
   * The CID (externalUserId) is the Bhutanese national ID — same field as dkCid.
   * Existing DK Bank users are found by CID and logged in without creating a duplicate.
   */
  async loginWithBhutanApp(dto: {
    token: string;
    externalUserId: string;
    fullName: string;
    username?: string;
    phoneNumber?: string;
    email?: string;
    referralCode?: string;
  }) {
    // ── Verify BhutanApp JWT signature (RS256) ────────────────────────────────
    const rawKey = process.env.BHUTANAPP_JWT_PUBLIC_KEY;
    if (!rawKey) {
      throw new Error("BHUTANAPP_JWT_PUBLIC_KEY is not configured");
    }
    // .env stores the key with literal \n — convert to real newlines
    const publicKey = rawKey.replace(/\\n/g, "\n");

    // Constrain issuer/audience so a validly-signed token minted for a DIFFERENT
    // service can't be replayed here (a valid signature only proves the token
    // wasn't tampered with — not that it was issued for us). Enforced only when
    // the expected values are configured, so existing logins keep working until
    // the values are set; set BHUTANAPP_JWT_ISSUER and BHUTANAPP_JWT_AUDIENCE to
    // turn enforcement on.
    const expectedIssuer = process.env.BHUTANAPP_JWT_ISSUER?.trim();
    const expectedAudience = process.env.BHUTANAPP_JWT_AUDIENCE?.trim();
    if (!expectedIssuer || !expectedAudience) {
      this.logger.warn(
        "[Auth] BhutanApp token issuer/audience not enforced — set " +
          "BHUTANAPP_JWT_ISSUER and BHUTANAPP_JWT_AUDIENCE to constrain tokens",
      );
    }
    const verifyOptions: jwt.VerifyOptions = { algorithms: ["RS256"] };
    if (expectedIssuer) verifyOptions.issuer = expectedIssuer;
    if (expectedAudience) verifyOptions.audience = expectedAudience;

    let claims: jwt.JwtPayload;
    try {
      claims = jwt.verify(dto.token, publicKey, verifyOptions) as jwt.JwtPayload;
    } catch (err: any) {
      this.logger.warn(
        `[Auth] BhutanApp token verification failed: ${err.message}`,
      );
      throw new UnauthorizedException("Invalid or expired BhutanApp token");
    }

    // ── Identity: anchor on the cryptographically-verified BhutanApp userId ───
    // The signed token carries only { userId, type, iat, exp } — NOT the CID.
    // The CID (dto.username) and phone (dto.phoneNumber) arrive in the REQUEST
    // BODY, which the caller controls, so they must never select an account on
    // their own. Account resolution is keyed on the verified userId; the body
    // CID is used only to find/create the DK account on a genuinely first-time
    // login, and merging into a PROTECTED account requires proving the
    // DK-registered phone via OTP.
    const bhutanUserId = (claims.userId ?? "").toString().trim();
    if (!bhutanUserId) {
      throw new UnauthorizedException(
        "BhutanApp token does not contain a user id",
      );
    }
    // Defence in depth: the body's externalUserId must match the signed id.
    if (dto.externalUserId && dto.externalUserId.trim() !== bhutanUserId) {
      throw new UnauthorizedException("BhutanApp identity mismatch");
    }

    let user: User | null = null;

    // (1) Returning user — resolve by the verified userId.
    const byUserId = await this.authMethodRepo.findOne({
      where: { provider: AuthProvider.BHUTANAPP, providerId: bhutanUserId },
    });
    if (byUserId) {
      user = await this.userRepo.findOneBy({ id: byUserId.userId });
    }

    // (2) Existing BhutanApp user from BEFORE this fix — those auth_method rows
    // were keyed by CID but stored the userId in metadata.externalUserId. Match
    // on that and re-key to providerId=userId so future logins hit path (1). No
    // OTP: the same cryptographically-verified userId proves it's the same
    // person, so this migrates existing users with zero friction.
    if (!user) {
      const legacy = await this.authMethodRepo
        .createQueryBuilder("am")
        .where("am.provider = :p", { p: AuthProvider.BHUTANAPP })
        .andWhere("am.metadata ->> 'externalUserId' = :uid", {
          uid: bhutanUserId,
        })
        .getOne();
      if (legacy) {
        legacy.providerId = bhutanUserId;
        await this.authMethodRepo.save(legacy);
        user = await this.userRepo.findOneBy({ id: legacy.userId });
        this.logger.log(
          `[Auth] BhutanApp auth_method re-keyed to userId for user ${user?.id}`,
        );
      }
    }

    // (3) First-time for this BhutanApp identity — now we need the body CID to
    // find/create the DK account. It is UNTRUSTED, so it may never take over a
    // protected account without an OTP proving the DK-registered phone.
    let cid = "";
    if (!user) {
      cid = (dto.username ?? "").toString().trim();
      if (!/^\d{11}$/.test(cid)) {
        throw new UnauthorizedException(
          "A valid 11-digit CID is required to create your account",
        );
      }

      // Resolve a candidate existing account by CID, then by DK-phone hash.
      let candidate = await this.userRepo.findOneBy({ dkCid: cid });
      let dkPhone: string | null = null;
      try {
        const account = await this.dkGateway.lookupAccountByCID(cid);
        dkPhone = account.phoneNumber || null;
      } catch (err) {
        this.logger.debug(
          `[Auth] BhutanApp login: DK lookup failed for CID ${cid} — ${(err as Error).message}`,
        );
        dkPhone = dto.phoneNumber || null;
      }
      if (!candidate && dkPhone) {
        const phoneHash = this.telegramVerification.hashPhone(dkPhone);
        candidate =
          (await this.userRepo.findOneBy({ telegramPhoneHash: phoneHash })) ??
          (await this.userRepo.findOneBy({ dkPhoneHash: phoneHash }));
      }

      if (candidate) {
        // Protected = a verified account (telegram phone == DK phone) OR one
        // already claimed by some BhutanApp identity. Binding this userId to a
        // protected account requires proving the DK phone via OTP.
        const verified =
          !!candidate.telegramPhoneHash &&
          !!candidate.dkPhoneHash &&
          candidate.telegramPhoneHash === candidate.dkPhoneHash;
        const claimedByBhutan = await this.authMethodRepo.findOne({
          where: { provider: AuthProvider.BHUTANAPP, userId: candidate.id },
        });
        const isProtected = verified || !!claimedByBhutan;

        if (isProtected) {
          if (!dkPhone) {
            throw new BadRequestException(
              "This CID is already linked to an account and ownership can't be " +
                "verified — no phone on file. Please contact support.",
            );
          }
          const otp = randomInt(100000, 1000000).toString();
          const challengeId = randomUUID();
          await this.redis.setJsonEx(`bhutan_merge:${challengeId}`, 300, {
            otp,
            bhutanUserId,
            candidateUserId: candidate.id,
            cid,
            dkPhoneHash: this.telegramVerification.hashPhone(dkPhone),
            profile: {
              fullName: dto.fullName,
              username: dto.username ?? null,
              email: dto.email ?? null,
              phoneNumber: dto.phoneNumber ?? null,
            },
            attempts: 0,
          });
          await this.smsService.sendOtp(dkPhone, otp);
          this.logger.log(
            `[Auth] BhutanApp merge OTP sent for candidate ${candidate.id} (challenge ${challengeId})`,
          );
          const local = dkPhone.replace(/[\s\-+]/g, "");
          const maskedPhone =
            local.length >= 4 ? `****${local.slice(-4)}` : "****";
          return { requiresOtp: true, challengeId, maskedPhone } as any;
        }

        // Unverified orphan (e.g. a DK-import stub) — safe to bind directly.
        user = candidate;
        if (!user.dkCid) {
          await this.userRepo.update(user.id, { dkCid: cid });
          user = await this.userRepo.findOneBy({ id: user.id });
        }
      }
    }

    if (user) {
      // Existing user — update profile fields BhutanApp provided if missing
      const updates: Partial<User> = {};
      if (!user.email && dto.email) updates.email = dto.email;
      if (!user.phoneNumber && dto.phoneNumber)
        updates.phoneNumber = dto.phoneNumber;
      if (dto.referralCode && !user.referredByUserId) {
        const raw = dto.referralCode.startsWith("ref_") ? dto.referralCode.slice(4) : dto.referralCode;
        const refTelegramId = raw.split("_m_")[0];
        if (refTelegramId) {
          const referrer = await this.userRepo.findOne({
            where: { telegramId: refTelegramId },
            select: ["id"],
          });
          if (referrer) updates.referredByUserId = referrer.id;
        }
      }
      if (Object.keys(updates).length)
        await this.userRepo.update(user.id, updates);

      // Ensure the BhutanApp auth_method row exists, keyed on the VERIFIED
      // userId (idempotent). Path (1)/(2) above already found/re-keyed it; this
      // covers the orphan-bind case where no row exists yet.
      const existing = await this.authMethodRepo.findOne({
        where: { provider: AuthProvider.BHUTANAPP, providerId: bhutanUserId },
      });
      if (!existing) {
        await this.authMethodRepo.save(
          this.authMethodRepo.create({
            provider: AuthProvider.BHUTANAPP,
            providerId: bhutanUserId,
            metadata: {
              fullName: dto.fullName,
              username: dto.username,
              externalUserId: bhutanUserId,
            },
            user,
            userId: user.id,
          }),
        );
      }

      const fresh = await this.userRepo.findOneBy({ id: user.id });
      const token = this.jwtService.sign({
        sub: fresh!.id,
        isAdmin: fresh!.isAdmin,
        jti: randomUUID(),
      });
      return { token, user: stripSensitiveFields(fresh!) };
    }

    // ── Brand new user — BhutanApp is the primary identity ────────────────────
    let bhutanNewUserReferredById: string | null = null;
    if (dto.referralCode) {
      const raw = dto.referralCode.startsWith("ref_") ? dto.referralCode.slice(4) : dto.referralCode;
      const refTelegramId = raw.split("_m_")[0];
      if (refTelegramId) {
        const referrer = await this.userRepo.findOne({
          where: { telegramId: refTelegramId },
          select: ["id"],
        });
        if (referrer) bhutanNewUserReferredById = referrer.id;
      }
    }
    const nameParts = dto.fullName.trim().split(" ");
    user = this.userRepo.create({
      firstName: nameParts[0] || dto.fullName,
      lastName: nameParts.slice(1).join(" ") || null,
      dkCid: cid,
      // Do not copy BhutanApp username — it may collide with an existing oro username.
      // Users can set their own username in settings.
      phoneNumber: dto.phoneNumber || null,
      email: dto.email || null,
      referredByUserId: bhutanNewUserReferredById,
      // Mirror Telegram onboarding: explicit starter reputation so callers
      // can sort/filter by score without null-handling everywhere. The DB
      // default exists but TypeORM may not apply it when nullable=true.
      reputationScore: 0.5,
    });
    await this.userRepo.save(user);

    await this.authMethodRepo.save(
      this.authMethodRepo.create({
        provider: AuthProvider.BHUTANAPP,
        providerId: bhutanUserId,
        metadata: {
          fullName: dto.fullName,
          username: dto.username,
          externalUserId: bhutanUserId,
        },
        user,
        userId: user.id,
      }),
    );

    this.logger.log(
      `[Auth] New user created via BhutanApp — userId ${bhutanUserId}, id ${user.id}`,
    );

    const token = this.jwtService.sign({
      sub: user.id,
      isAdmin: user.isAdmin,
      jti: randomUUID(),
    });
    return { token, user: stripSensitiveFields(user) };
  }

  /**
   * Step 2 of a PROTECTED BhutanApp merge: the user proves control of the
   * DK-registered phone by entering the OTP we sent in loginWithBhutanApp.
   * Only on success do we bind their verified BhutanApp userId to the existing
   * account — this is what lets a genuine cross-channel user reach their
   * verified account without ever trusting a request-body CID.
   */
  async verifyBhutanAppMerge(challengeId: string, otp: string) {
    const key = `bhutan_merge:${challengeId}`;
    const stored = await this.redis.getJson<{
      otp: string;
      bhutanUserId: string;
      candidateUserId: string;
      cid: string;
      dkPhoneHash: string;
      profile: {
        fullName?: string;
        username?: string | null;
        email?: string | null;
        phoneNumber?: string | null;
      };
      attempts: number;
    }>(key);

    if (!stored) {
      throw new UnauthorizedException(
        "Verification expired or not found. Please log in again.",
      );
    }

    if (stored.otp !== otp) {
      stored.attempts++;
      if (stored.attempts >= 3) {
        await this.redis.del(key);
        throw new UnauthorizedException(
          "Too many failed attempts. Please log in again.",
        );
      }
      await this.redis.setJsonEx(key, 300, stored);
      throw new UnauthorizedException(
        `Invalid OTP. ${3 - stored.attempts} attempts remaining.`,
      );
    }

    await this.redis.del(key);

    const target = await this.userRepo.findOneBy({ id: stored.candidateUserId });
    if (!target) {
      throw new UnauthorizedException("Account no longer exists.");
    }

    // Bind the verified BhutanApp identity to the now phone-proven account.
    const existing = await this.authMethodRepo.findOne({
      where: {
        provider: AuthProvider.BHUTANAPP,
        providerId: stored.bhutanUserId,
      },
    });
    if (!existing) {
      await this.authMethodRepo.save(
        this.authMethodRepo.create({
          provider: AuthProvider.BHUTANAPP,
          providerId: stored.bhutanUserId,
          metadata: {
            fullName: stored.profile?.fullName,
            username: stored.profile?.username ?? undefined,
            externalUserId: stored.bhutanUserId,
          },
          user: target,
          userId: target.id,
        }),
      );
    }
    // The OTP proved ownership of this CID's phone — safe to stamp the CID.
    if (!target.dkCid) {
      await this.userRepo.update(target.id, { dkCid: stored.cid });
    }

    const fresh = await this.userRepo.findOneBy({ id: target.id });
    const token = this.jwtService.sign({
      sub: fresh!.id,
      isAdmin: fresh!.isAdmin,
      jti: randomUUID(),
    });
    this.logger.log(
      `[Auth] BhutanApp merge verified — userId ${stored.bhutanUserId} bound to ${target.id}`,
    );
    return { token, user: stripSensitiveFields(fresh!) };
  }

  // ── Link CID (PWA account merge) ─────────────────────────────────────────
  /**
   * Called from the PWA wallet when a BhutanApp-authenticated user enters their
   * 11-digit CID to link to their existing DK Bank / TMA account.
   *
   * - If a different user already owns this CID: transfers balance and the
   *   BhutanApp auth_method to that user, then returns a JWT for that user.
   * - Otherwise: updates the caller's DK Bank fields and returns a refreshed JWT.
   */
  async linkCidAccount(callerUserId: string, cid: string) {
    const cid11 = cid.trim();
    if (cid11.length !== 11 || !/^\d{11}$/.test(cid11)) {
      throw new BadRequestException("CID must be exactly 11 digits");
    }

    const caller = await this.userRepo.findOneBy({ id: callerUserId });
    if (!caller) throw new UnauthorizedException("User not found");

    // Look up the DK Bank account — confirms the CID is real
    const account = await this.dkGateway.lookupAccountByCID(cid11);

    // Find any OTHER user that already owns this CID or matching phone.
    // The caller (BhutanApp user Y) may already have dkCid set on themselves
    // from login — exclude them so we don't "merge into self" and miss the
    // real TMA user X (who'd only be findable via phone hash).
    let target: User | null = await this.userRepo.findOneBy({ dkCid: cid11 });
    if (target?.id === callerUserId) target = null;

    if (!target && account.phoneNumber) {
      const hash = this.telegramVerification.hashPhone(account.phoneNumber);
      const byTgPhone = await this.userRepo.findOneBy({
        telegramPhoneHash: hash,
      });
      if (byTgPhone && byTgPhone.id !== callerUserId) {
        target = byTgPhone;
      } else {
        const byDkPhone = await this.userRepo.findOneBy({
          dkPhoneHash: hash,
        });
        if (byDkPhone && byDkPhone.id !== callerUserId) target = byDkPhone;
      }
    }

    if (target && target.id !== callerUserId) {
      // ── SECURITY: refuse to merge into an already-verified TMA account ──────
      // Same guard as loginWithDKBank — prevents account takeover by anyone
      // who happens to know a victim's CID. A truly verified user has both
      // telegram & DK phone hashes that match, proving phone-level ownership.
      const targetVerified =
        target.telegramPhoneHash &&
        target.dkPhoneHash &&
        target.telegramPhoneHash === target.dkPhoneHash;
      if (targetVerified) {
        throw new BadRequestException(
          "This CID is already linked to a verified account. " +
            "Please log in via your Telegram account or contact support.",
        );
      }

      // ── Merge caller INTO target (target is an unverified orphan) ──────────
      // Wrap balance transfer + auth_method move in a single DB transaction
      // so they're atomic — no half-merged state if anything fails.
      await this.userRepo.manager.transaction(async (tx) => {
        const txRepo = tx.getRepository(Transaction);
        const amRepo = tx.getRepository(AuthMethod);
        const uRepo = tx.getRepository(User);

        const callerRow = await txRepo
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "bal")
          .where("t.userId = :id", { id: callerUserId })
          .getRawOne<{ bal: string }>();
        const targetRow = await txRepo
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "bal")
          .where("t.userId = :id", { id: target!.id })
          .getRawOne<{ bal: string }>();

        const callerBalance = Number(callerRow?.bal ?? 0);
        const targetBalance = Number(targetRow?.bal ?? 0);

        if (callerBalance > 0) {
          await txRepo.save(
            txRepo.create({
              type: TransactionType.WITHDRAWAL,
              amount: -callerBalance,
              balanceBefore: callerBalance,
              balanceAfter: 0,
              userId: callerUserId,
              note: "Balance transferred to linked account",
            }),
          );
          await txRepo.save(
            txRepo.create({
              type: TransactionType.DEPOSIT,
              amount: callerBalance,
              balanceBefore: targetBalance,
              balanceAfter: targetBalance + callerBalance,
              userId: target!.id,
              note: "Balance received from BhutanApp account merge",
            }),
          );
        }

        await amRepo.update(
          { provider: AuthProvider.BHUTANAPP, userId: callerUserId },
          { userId: target!.id },
        );

        // CRITICAL: dkCid and dkAccountNumber are UNIQUE in the DB. The caller
        // (BhutanApp user Y) has dkCid set from login — we must clear it
        // BEFORE writing the same value onto the target, otherwise the unique
        // constraint fires and the whole transaction rolls back.
        await uRepo.update(callerUserId, {
          dkCid: null as any,
          dkAccountNumber: null as any,
          dkAccountName: null as any,
          phoneNumber: null as any,
          dkPhoneHash: null as any,
        });

        await uRepo.update(target!.id, {
          dkCid: cid11,
          dkAccountNumber: account.accountNumber,
          dkAccountName: account.accountName,
          phoneNumber: account.phoneNumber || null,
        });
      });

      // dkPhoneHash + audit log happen outside the txn — they're best-effort
      await this.telegramVerification.storeDKPhoneHash(
        target.id,
        account.phoneNumber,
      );

      await this.auditService
        .log({
          adminId: target.id,
          username: target.username || target.firstName || "Unknown",
          isAdmin: target.isAdmin,
          action: AuditAction.USER_LOGIN,
          entityType: "user",
          entityId: target.id,
          meta: {
            event: "pwa_account_merge",
            mergedFromUserId: callerUserId,
            cid: cid11,
          },
        })
        .catch(() => {});

      this.logger.log(
        `[Auth] PWA merge: caller ${callerUserId} merged into ${target.id} via CID ${cid11}`,
      );

      const fresh = await this.userRepo.findOneBy({ id: target.id });
      const token = this.jwtService.sign({
        sub: fresh!.id,
        isAdmin: fresh!.isAdmin,
        jti: randomUUID(),
      });
      return { token, user: stripSensitiveFields(fresh!), merged: true };
    }

    // ── No other user owns this CID — update caller's own DK fields ──────────
    await this.userRepo.update(callerUserId, {
      dkCid: cid11,
      dkAccountNumber: account.accountNumber,
      dkAccountName: account.accountName,
      phoneNumber: account.phoneNumber || null,
    });
    await this.telegramVerification.storeDKPhoneHash(
      callerUserId,
      account.phoneNumber,
    );

    // Upsert the DKBANK auth_method
    const existing = await this.authMethodRepo.findOne({
      where: {
        provider: AuthProvider.DKBANK,
        providerId: account.accountNumber,
      },
    });
    if (!existing) {
      await this.authMethodRepo.save(
        this.authMethodRepo.create({
          provider: AuthProvider.DKBANK,
          providerId: account.accountNumber,
          metadata: { cid: cid11, accountName: account.accountName },
          userId: callerUserId,
        }),
      );
    }

    const fresh = await this.userRepo.findOneBy({ id: callerUserId });
    const token = this.jwtService.sign({
      sub: fresh!.id,
      isAdmin: fresh!.isAdmin,
      jti: randomUUID(),
    });
    return { token, user: stripSensitiveFields(fresh!), merged: false };
  }

  // ── PWA phone verification (SMS OTP) ──────────────────────────────────────
  /**
   * Sends a 6-digit SMS OTP to the supplied phone number. The OTP is stored
   * in Redis keyed by the user's id (5-minute expiry, 3 attempts max).
   * Used by PWA users to verify a phone they can later receive withdrawal
   * OTPs on (PWA has no Telegram chat to deliver to).
   */
  async sendPwaPhoneOtp(userId: string, phoneNumber: string) {
    const cleaned = phoneNumber.trim();
    if (!/^\+?\d{8,15}$/.test(cleaned.replace(/[\s\-]/g, ""))) {
      throw new BadRequestException("Invalid phone number format.");
    }

    // ── Trust check: phone MUST match the DK Bank record for this CID ──────
    // Otherwise verifying any phone they happen to own proves nothing about
    // the DK Bank account. Same security model as TMA's phone-share flow.
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException("User not found");
    if (!user.dkCid) {
      throw new BadRequestException(
        "Link your DK Bank account first before verifying a phone.",
      );
    }
    if (!user.dkPhoneHash) {
      throw new BadRequestException(
        "Your DK Bank account has no registered phone number. " +
          "Please update your contact info with DK Bank before verifying.",
      );
    }
    const enteredHash = this.telegramVerification.hashPhone(cleaned);
    if (enteredHash !== user.dkPhoneHash) {
      throw new BadRequestException(
        "This phone number does not match the one registered with " +
          "DK Bank for your CID. Please use your DK Bank phone number.",
      );
    }

    // Per-user throttle: one OTP per 60s to prevent SMS-spam abuse
    const { allowed } = await this.redis.rateLimit(
      `pwa-phone-otp:send:${userId}`,
      1,
      60,
    );
    if (!allowed) {
      throw new BadRequestException(
        "Please wait a minute before requesting another code.",
      );
    }

    const otp = randomInt(100000, 1000000).toString();
    const redisKey = `pwa_phone_otp:${userId}`;
    await this.redis.setJsonEx(redisKey, 300, {
      otp,
      phoneNumber: cleaned,
      attempts: 0,
    });

    const message = `Your Oro verification code is ${otp}. It expires in 5 minutes. Do not share it with anyone.`;
    const sent = await this.smsService.sendSms(cleaned, message);
    if (!sent) {
      // Keep the OTP record so the user can retry verify, but signal the
      // delivery failure clearly.
      throw new BadRequestException(
        "Could not deliver SMS. Please check the number and try again.",
      );
    }

    this.logger.log(`[PwaPhoneOtp] Sent OTP to user ${userId}`);
    return { ok: true, message: "Verification code sent." };
  }

  /**
   * Verifies the OTP, marks the phone as the user's verified phone
   * (telegramPhoneHash + raw phoneNumber + telegramLinkedAt), and returns
   * the refreshed user.
   */
  async verifyPwaPhoneOtp(userId: string, otp: string) {
    const redisKey = `pwa_phone_otp:${userId}`;
    const stored = await this.redis.getJson<{
      otp: string;
      phoneNumber: string;
      attempts: number;
    }>(redisKey);
    if (!stored) {
      throw new UnauthorizedException(
        "Code expired or not found. Request a new one.",
      );
    }

    if (stored.otp !== otp) {
      stored.attempts++;
      if (stored.attempts >= 3) {
        await this.redis.del(redisKey);
        throw new UnauthorizedException(
          "Too many incorrect attempts. Request a new code.",
        );
      }
      await this.redis.setJsonEx(redisKey, 300, stored);
      throw new UnauthorizedException(
        `Incorrect code. ${3 - stored.attempts} attempts left.`,
      );
    }

    await this.redis.del(redisKey);

    const phoneHash = this.telegramVerification.hashPhone(stored.phoneNumber);
    await this.userRepo.update(userId, {
      phoneNumber: stored.phoneNumber,
      telegramPhoneHash: phoneHash,
      telegramLinkedAt: new Date(),
    });

    this.logger.log(`[PwaPhoneOtp] User ${userId} verified phone`);

    const fresh = await this.userRepo.findOneBy({ id: userId });
    return { ok: true, user: stripSensitiveFields(fresh!) };
  }

  // ── Helper: transfer all balance from one user to another ─────────────────
  /**
   * Drains `fromId`'s transaction-summed balance and credits it to `toId`.
   * Used during account merges so the orphan PWA user's funds follow them
   * to the linked TMA user record. Returns the amount moved (0 if nothing).
   */
  private async transferOrphanBalance(
    fromId: string,
    toId: string,
  ): Promise<number> {
    const fromRow = await this.transactionRepo
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "bal")
      .where("t.userId = :id", { id: fromId })
      .getRawOne<{ bal: string }>();
    const balance = Number(fromRow?.bal ?? 0);
    if (balance <= 0) return 0;

    const toRow = await this.transactionRepo
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "bal")
      .where("t.userId = :id", { id: toId })
      .getRawOne<{ bal: string }>();
    const targetBalance = Number(toRow?.bal ?? 0);

    await this.transactionRepo.save([
      this.transactionRepo.create({
        type: TransactionType.WITHDRAWAL,
        amount: -balance,
        balanceBefore: balance,
        balanceAfter: 0,
        userId: fromId,
        note: "Balance transferred to linked account",
      }),
      this.transactionRepo.create({
        type: TransactionType.DEPOSIT,
        amount: balance,
        balanceBefore: targetBalance,
        balanceAfter: targetBalance + balance,
        userId: toId,
        note: "Balance received from account merge",
      }),
    ]);

    // Bust both users' cached balances
    await this.redis.del(`oro:cache:balance:${fromId}`).catch(() => {});
    await this.redis.del(`oro:cache:balance:${toId}`).catch(() => {});

    this.logger.log(
      `[Auth] Transferred Nu ${balance} from ${fromId} to ${toId}`,
    );
    return balance;
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
