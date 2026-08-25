import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { Repository, DataSource } from "typeorm";
import { randomBytes, randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { User, KycStatus } from "../entities/user.entity";
import { AuthMethod, AuthProvider } from "../entities/auth-method.entity";
import { RedisService } from "../redis/redis.service";
import { EmailService } from "../shared/services/email.service";

/** Verification and reset tokens live in Redis, like the existing OTP flows. */
const VERIFY_PREFIX = "auth:email:verify:";
const RESET_PREFIX = "auth:email:reset:";
const VERIFY_TTL_SECONDS = 24 * 60 * 60;
const RESET_TTL_SECONDS = 30 * 60;

/** bcrypt cost. Matches what the existing PWA password path uses. */
const BCRYPT_ROUNDS = 10;

/**
 * Email + password authentication, for users with no BhutanApp, DK Bank or
 * Telegram identity.
 *
 * Deliberately a separate service rather than more methods on `auth.service.ts`:
 * that file serves 1,300 live users across three providers and must not move.
 *
 * The credential itself is not new — `users.pwaPasswordHash` and bcrypt
 * verification already exist. What is new is email as an *identity*. That
 * changes the threat model rather than the mechanism: for an existing account
 * the password is a convenience layered on an external provider, and for an
 * email account it is the only thing standing between an attacker and the
 * money. Hence verification before anything matters, single-use reset tokens,
 * and hard rate limits on the routes.
 *
 * See docs/usdt-oro/STAGE-G-ONBOARDING-KYC.md.
 */
@Injectable()
export class EmailAuthService {
  private readonly logger = new Logger(EmailAuthService.name);
  /** Built lazily so a deployment without Google configured still boots. */
  private googleClient: OAuth2Client | null = null;

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(AuthMethod)
    private readonly authMethodRepo: Repository<AuthMethod>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
  ) {}

  /**
   * Normalised form of an address, used as the identity key.
   *
   * Applied on every write. `auth_methods` is unique on
   * `(provider, providerId)`, so one un-normalised insert would let
   * `User@x.com` and `user@x.com` both exist — the constraint cannot see that
   * they are the same person.
   */
  private normalise(email: string): string {
    return String(email ?? "")
      .trim()
      .toLowerCase();
  }

  private assertValidEmail(email: string): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new BadRequestException("Enter a valid email address");
    }
  }

  private assertValidPassword(password: string): void {
    if (typeof password !== "string" || password.length < 10) {
      throw new BadRequestException(
        "Password must be at least 10 characters long",
      );
    }
    if (password.length > 200) {
      throw new BadRequestException("Password is too long");
    }
  }

  /**
   * Register a new email account.
   *
   * The user row is created immediately, unverified and with no KYC. It can do
   * nothing until both change: deposit is gated on KYC approval, and document
   * upload is gated on the address being verified.
   *
   * Currency is set to USDT at creation and never changes. That single write
   * is what places the account on the crypto side of the boundary for good.
   */
  async register(
    emailRaw: string,
    password: string,
  ): Promise<{ status: "verification_sent" }> {
    const email = this.normalise(emailRaw);
    this.assertValidEmail(email);
    this.assertValidPassword(password);

    const existing = await this.authMethodRepo.findOne({
      where: { provider: AuthProvider.EMAIL, providerId: email },
    });

    if (existing) {
      // Deliberately the same response as a fresh signup. Saying "that address
      // is taken" turns this route into an oracle for which addresses hold an
      // account, which on a money platform is worth something to an attacker.
      this.logger.log(`[EmailAuth] Re-registration attempt for a known address`);
      await this.issueVerification(existing.userId, email).catch(() => null);
      return { status: "verification_sent" };
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const userId = await this.dataSource.transaction(async (em) => {
      const user = em.create(User, {
        email,
        pwaPasswordHash: passwordHash,
        currency: "USDT",
        kycStatus: KycStatus.NONE,
      });
      const saved = await em.save(User, user);

      await em.save(
        AuthMethod,
        em.create(AuthMethod, {
          provider: AuthProvider.EMAIL,
          providerId: email,
          userId: saved.id,
        }),
      );
      return saved.id;
    });

    await this.issueVerification(userId, email);
    return { status: "verification_sent" };
  }

  /** Mint a single-use verification token and email it. */
  private async issueVerification(
    userId: string,
    email: string,
  ): Promise<void> {
    const token = randomBytes(32).toString("hex");
    await this.redis.setJsonEx(`${VERIFY_PREFIX}${token}`, VERIFY_TTL_SECONDS, {
      userId,
      email,
    });

    await this.email.sendEmail({
      to: email,
      subject: "Verify your Oro account",
      text:
        `Use this code to verify your Oro account:\n\n${token}\n\n` +
        `It expires in 24 hours. If you did not create an account, ignore this email.`,
    });
  }

  /**
   * Confirm an address. Single use: the token is deleted whether or not the
   * account was already verified, so a leaked link cannot be replayed.
   */
  async verify(token: string): Promise<{ verified: true }> {
    const key = `${VERIFY_PREFIX}${token}`;
    const payload = await this.redis.getJson<{ userId: string; email: string }>(
      key,
    );
    if (!payload) {
      throw new BadRequestException(
        "This verification link is invalid or has expired",
      );
    }
    await this.redis.del(key);

    await this.userRepo.update(
      { id: payload.userId },
      { emailVerifiedAt: new Date() },
    );
    return { verified: true };
  }

  /**
   * Log in with email and password.
   *
   * One message for every failure — unknown address, no password set, wrong
   * password. Distinguishing them tells an attacker which addresses are worth
   * attacking.
   */
  async login(
    emailRaw: string,
    password: string,
  ): Promise<{ token: string; user: Partial<User> }> {
    const email = this.normalise(emailRaw);
    const generic = new UnauthorizedException("Invalid email or password");

    const identity = await this.authMethodRepo.findOne({
      where: { provider: AuthProvider.EMAIL, providerId: email },
    });
    if (!identity) throw generic;

    const user = await this.userRepo.findOne({
      where: { id: identity.userId },
      select: ["id", "isAdmin", "pwaPasswordHash"],
    });
    if (!user?.pwaPasswordHash) throw generic;

    const ok = await bcrypt.compare(password, user.pwaPasswordHash);
    if (!ok) throw generic;

    const fresh = await this.userRepo.findOneBy({ id: user.id });
    const token = this.jwtService.sign({
      sub: fresh!.id,
      isAdmin: fresh!.isAdmin,
      jti: randomUUID(),
    });

    const { pwaPasswordHash: _p, dkPhoneHash: _d, ...safe } = fresh as any;
    return { token, user: safe };
  }

  /**
   * Start a password reset.
   *
   * Always reports success. A route that says "no account with that address"
   * enumerates users for free.
   */
  async requestReset(emailRaw: string): Promise<{ status: "sent" }> {
    const email = this.normalise(emailRaw);
    const identity = await this.authMethodRepo.findOne({
      where: { provider: AuthProvider.EMAIL, providerId: email },
    });

    if (identity) {
      const token = randomBytes(32).toString("hex");
      await this.redis.setJsonEx(`${RESET_PREFIX}${token}`, RESET_TTL_SECONDS, {
        userId: identity.userId,
      });
      await this.email.sendEmail({
        to: email,
        subject: "Reset your Oro password",
        text:
          `Use this code to reset your Oro password:\n\n${token}\n\n` +
          `It expires in 30 minutes and can be used once. If you did not ` +
          `request this, ignore this email — your password has not changed.`,
      });
    }

    return { status: "sent" };
  }

  /** Complete a reset. The token is consumed before the password is written. */
  async completeReset(
    token: string,
    newPassword: string,
  ): Promise<{ status: "reset" }> {
    this.assertValidPassword(newPassword);

    const key = `${RESET_PREFIX}${token}`;
    const payload = await this.redis.getJson<{ userId: string }>(key);
    if (!payload) {
      throw new BadRequestException(
        "This reset link is invalid or has expired",
      );
    }
    // Consumed first: a crash between here and the update costs the user a
    // second reset email, where the reverse would leave a live token behind.
    await this.redis.del(key);

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.userRepo.update(
      { id: payload.userId },
      { pwaPasswordHash: passwordHash },
    );
    return { status: "reset" };
  }

  // ── Google Sign-In ─────────────────────────────────────────────────────────

  private google(): OAuth2Client {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new ServiceUnavailableException(
        "Google sign-in is not configured on this deployment",
      );
    }
    if (!this.googleClient) this.googleClient = new OAuth2Client(clientId);
    return this.googleClient;
  }

  /**
   * A client capable of the authorization-code exchange.
   *
   * The app renders its OWN branded sign-in button and opens Google in a popup
   * (auth-code flow) — Google's embedded button lives in an un-restylable iframe,
   * and hiding it under a custom button is blocked by Google's anti-clickjacking
   * protection. The popup returns a one-time code; exchanging it for tokens needs
   * the client SECRET as well as the id (unlike `verifyIdToken`). `postmessage`
   * is the special redirect the popup code flow uses.
   */
  private googleCodeClient(): OAuth2Client {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException(
        "Google sign-in is not configured on this deployment",
      );
    }
    return new OAuth2Client(clientId, clientSecret, "postmessage");
  }

  /**
   * Sign in with a Google authorization code (popup / auth-code flow).
   *
   * We exchange the one-time code for tokens, then hand the returned ID token to
   * the exact same verification as the embedded-button flow below — nothing the
   * client sends is trusted until that verification passes.
   */
  async loginWithGoogleCode(
    code: string,
    referralCode?: string,
  ): Promise<{ token: string; user: Partial<User>; isNew: boolean }> {
    if (!code?.trim()) {
      throw new BadRequestException("Missing Google authorization code");
    }
    let idToken: string | undefined;
    try {
      const { tokens } = await this.googleCodeClient().getToken(code);
      idToken = tokens.id_token ?? undefined;
    } catch {
      throw new UnauthorizedException("Google sign-in failed");
    }
    if (!idToken) throw new UnauthorizedException("Google sign-in failed");
    return this.loginWithGoogle(idToken, referralCode);
  }

  /**
   * Sign in with a Google ID token.
   *
   * The token is verified against Google's public keys with our client id as
   * the audience. **Nothing the client sends is trusted** — not the email, not
   * the name, not the subject. A caller that could assert its own email could
   * assert anybody's.
   */
  async loginWithGoogle(
    idToken: string,
    referralCode?: string,
  ): Promise<{ token: string; user: Partial<User>; isNew: boolean }> {
    if (!idToken?.trim()) {
      throw new BadRequestException("Missing Google credential");
    }

    // Resolved before the try: an unconfigured deployment must not be reported
    // as a failed sign-in. Inside the catch below, "no client id" and "your
    // token is bad" become the same 401, which sends the user to re-check
    // their Google account when the fault is entirely ours.
    const client = this.google();

    let payload: TokenPayload | undefined;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID!,
      });
      payload = ticket.getPayload();
    } catch {
      // Deliberately opaque: a caller learns only that it failed.
      throw new UnauthorizedException("Google sign-in failed");
    }
    if (!payload?.sub) throw new UnauthorizedException("Google sign-in failed");

    // Google can return an unverified address on some account types. Treating
    // one as proof of ownership is the whole vulnerability, so refuse it.
    if (!payload.email || payload.email_verified !== true) {
      throw new UnauthorizedException(
        "Your Google account does not have a verified email address",
      );
    }

    // Read out here so the closures below cannot see an optional payload.
    const googleId = payload.sub;
    const email = this.normalise(payload.email);
    const givenName = payload.given_name ?? null;
    const familyName = payload.family_name ?? null;
    const picture = payload.picture ?? null;
    const displayName = payload.name ?? null;

    // 1. Known Google identity — the common path.
    const identity = await this.authMethodRepo.findOne({
      where: { provider: AuthProvider.GOOGLE, providerId: googleId },
    });
    if (identity) {
      return { ...(await this.issueSession(identity.userId)), isNew: false };
    }

    // 2. First Google sign-in for an address we already hold. `users.email` is
    // unique, so this must link rather than create — the security-critical
    // branch.
    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) {
      await this.linkGoogleToExistingUser(existing, googleId);
      return { ...(await this.issueSession(existing.id)), isNew: false };
    }

    // 3. A new account. Attribute the referral only here — an existing account
    // keeps whoever referred it the first time.
    const referredByUserId = await this.resolveReferrer(referralCode);
    const userId = await this.dataSource.transaction(async (em) => {
      const user = await em.save(
        User,
        em.create(User, {
          email,
          firstName: givenName,
          lastName: familyName,
          photoUrl: picture,
          currency: "USDT",
          kycStatus: KycStatus.NONE,
          ...(referredByUserId ? { referredByUserId } : {}),
          // Google already proved the address; our own verification email
          // would add nothing.
          emailVerifiedAt: new Date(),
        }),
      );
      await em.save(
        AuthMethod,
        em.create(AuthMethod, {
          provider: AuthProvider.GOOGLE,
          providerId: googleId,
          userId: user.id,
          metadata: { email, name: displayName },
        }),
      );
      return user.id;
    });

    this.logger.log("[GoogleAuth] New account created for a Google identity");
    return { ...(await this.issueSession(userId)), isNew: true };
  }

  /**
   * Resolve a referral code to the referrer's user id.
   *
   * Codes are minted from Telegram ids, so a Google signup can only ever be
   * referred by a Telegram user — which is the realistic direction anyway. An
   * unknown or malformed code is ignored rather than rejected: a bad link must
   * never block a signup.
   */
  private async resolveReferrer(
    referralCode?: string,
  ): Promise<string | null> {
    if (!referralCode) return null;
    const raw = referralCode.startsWith("ref_")
      ? referralCode.slice(4)
      : referralCode;
    const refTelegramId = raw.split("_m_")[0];
    if (!refTelegramId) return null;
    const referrer = await this.userRepo.findOne({
      where: { telegramId: refTelegramId },
      select: ["id"],
    });
    return referrer?.id ?? null;
  }

  /**
   * Attach a Google identity to an account that already holds this address.
   *
   * The danger is specific. Someone can register `victim@gmail.com` with a
   * password and never verify it. If the real owner later signs in with Google
   * and we simply link, they are handed an account whose password an attacker
   * already knows.
   *
   * Google's verified claim is stronger evidence of ownership than an
   * unverified local registration, so that unproven password is discarded. The
   * rightful owner can set a new one; the attacker loses access they never
   * legitimately had.
   *
   * Where the account was already verified, both sides have proven ownership
   * and the password is left alone.
   */
  private async linkGoogleToExistingUser(
    user: User,
    googleId: string,
  ): Promise<void> {
    const wasVerified = !!user.emailVerifiedAt;

    await this.dataSource.transaction(async (em) => {
      await em.save(
        AuthMethod,
        em.create(AuthMethod, {
          provider: AuthProvider.GOOGLE,
          providerId: googleId,
          userId: user.id,
        }),
      );
      await em.update(
        User,
        { id: user.id },
        {
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          ...(wasVerified ? {} : { pwaPasswordHash: null as any }),
        },
      );
    });

    if (!wasVerified) {
      this.logger.warn(
        "[GoogleAuth] Linked Google to a previously UNVERIFIED account and " +
          "cleared its password — nobody had proven that address before now",
      );
    }
  }

  /** Shared session issuance, so every path returns the same shape. */
  private async issueSession(
    userId: string,
  ): Promise<{ token: string; user: Partial<User> }> {
    const fresh = await this.userRepo.findOneBy({ id: userId });
    const token = this.jwtService.sign({
      sub: fresh!.id,
      isAdmin: fresh!.isAdmin,
      jti: randomUUID(),
    });
    const { pwaPasswordHash: _p, dkPhoneHash: _d, ...safe } = fresh as any;
    return { token, user: safe };
  }
}
