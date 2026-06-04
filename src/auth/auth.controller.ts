import {
  Controller,
  Post,
  Body,
  HttpCode,
  Get,
  Query,
  UnauthorizedException,
  BadRequestException,
  UseGuards,
  Request,
  Response,
  Logger,
} from "@nestjs/common";
import type { Response as ExpressResponse } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBody,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { createHmac, timingSafeEqual } from "crypto";
import {
  IsNumber,
  IsString,
  IsOptional,
  MinLength as MinLengthValidator,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { verify as totpVerify } from "otplib";
import { AuthService } from "./auth.service";
import { Public, JwtAuthGuard } from "./guards";
import { TelegramAuthDto } from "./dto/telegram-auth.dto";
import { DKBankAuthDto } from "./dto/dkbank-auth.dto";
import { ManualLoginRequestDto } from "./dto/manual-login-request.dto";
import { ManualLoginVerifyDto } from "./dto/manual-login-verify.dto";
import { BhutanAppAuthDto } from "./dto/bhutanapp-auth.dto";
import { TelegramVerificationService } from "../telegram/telegram-verification.service";
import { AuditAction } from "../entities/audit-log.entity";

class AdminLoginDto {
  @ApiProperty({ description: "Value of ADMIN_DEV_SECRET in .env" })
  @IsString()
  secret: string;

  @ApiProperty({
    description: "6-digit TOTP code (required when ADMIN_TOTP_SECRET is set)",
    required: false,
  })
  @IsOptional()
  @IsString()
  totp?: string;
}

class SetPwaPasswordDto {
  @ApiProperty({
    example: "MySecret123",
    description: "New PWA password (min 6 chars)",
  })
  @IsString()
  @MinLengthValidator(6)
  password: string;
}

class DKBankAuthWithPasswordDto {
  @ApiProperty({
    description: "CID (11-digit national ID)",
    example: "11000000000",
  })
  @IsString()
  cid: string;

  @ApiProperty({
    description: "PWA password (required if one has been set)",
    required: false,
  })
  @IsOptional()
  @IsString()
  password?: string;
}

class PwaStatusDto {
  @ApiProperty({ description: "11-digit CID", example: "11000000000" })
  @IsString()
  cid: string;
}

class LinkCidDto {
  @ApiProperty({ description: "11-digit Bhutanese CID", example: "11000000000" })
  @IsString()
  @MinLengthValidator(11)
  cid: string;
}

class SendPwaPhoneOtpDto {
  @ApiProperty({ description: "Phone number to send the OTP to", example: "+97517123456" })
  @IsString()
  @MinLengthValidator(8)
  phoneNumber: string;
}

class VerifyPwaPhoneOtpDto {
  @ApiProperty({ description: "6-digit OTP received via SMS", example: "123456" })
  @IsString()
  @MinLengthValidator(6)
  otp: string;
}

class VerifyDKAccountDto {
  @ApiProperty({
    example: "1234567890",
    description: "Full DK Bank account number (as shown in your bank app)",
  })
  @IsString()
  accountNumber: string;
}

class VerifyPhoneTmaDto {
  @ApiProperty({
    example: "+97517123456",
    description: "Phone from Telegram contact",
  })
  @IsString()
  phoneNumber: string;

  @ApiProperty({
    example: 123456789,
    description: "Telegram user_id from contact data",
  })
  @IsNumber()
  userId: number;

  @ApiProperty({ example: 1700000000, description: "auth_date from Telegram" })
  @IsNumber()
  authDate: number;

  @ApiProperty({ description: "HMAC-SHA-256 hash from Telegram contact data" })
  @IsString()
  hash: string;
}

@ApiTags("auth")
@Controller("auth")
@Throttle({ default: { limit: 10, ttl: 60_000 } }) // 10 req/min per IP on all auth endpoints
export class AuthController {
  constructor(
    private authService: AuthService,
    private telegramVerification: TelegramVerificationService,
  ) {}

  private setAuthCookie(res: ExpressResponse, token: string) {
    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("oro_auth", token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "strict" : "lax",
      // Match JWT expiry (7 days). If you shorten JWT_EXPIRES_IN, lower this too.
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    });
  }

  @Get("refresh")
  @HttpCode(200)
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Silently restore a PWA session from the httpOnly cookie" })
  async refreshSession(
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const token: string | undefined = req.cookies?.["oro_auth"];
    if (!token) throw new UnauthorizedException("No session cookie");

    const user = await this.authService.getUserFromToken(token);
    // Re-issue the cookie to reset its maxAge
    this.setAuthCookie(res, token);
    return { token, user };
  }

  @Post("telegram")
  @HttpCode(200)
  @Public()
  @ApiOperation({
    summary: "Login/register with Telegram initData (HMAC validated)",
  })
  async telegramLogin(@Body() dto: TelegramAuthDto) {
    return this.authService.loginWithTelegram(dto.initData, dto.referralCode);
  }

  @Post("dkbank")
  @HttpCode(200)
  @Public()
  @ApiOperation({
    summary: "Login or register with DK Bank CID (password required if set)",
  })
  @ApiBody({ type: DKBankAuthWithPasswordDto })
  async dkBankLogin(
    @Body() dto: DKBankAuthWithPasswordDto,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const callerUserId: string | undefined = req.user?.userId;
    try {
      const result = await this.authService.loginWithDKBank(
        dto.cid,
        callerUserId,
        dto.password,
      );
      this.setAuthCookie(res, result.token);
      return result;
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        await this.authService
          .recordAuthFailure(
            AuditAction.AUTH_FAIL_DKBANK,
            dto.cid,
            req.ip ?? "unknown",
          )
          .catch(() => {});
      }
      throw e;
    }
  }

  @Post("bhutanapp")
  @HttpCode(200)
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Login or register via BhutanApp OAuth (QR/OTP flow)" })
  @ApiBody({ type: BhutanAppAuthDto })
  async bhutanAppLogin(
    @Body() dto: BhutanAppAuthDto,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const result = await this.authService.loginWithBhutanApp(dto);
    this.setAuthCookie(res, result.token);
    return result;
  }

  /**
   * Called from the PWA wallet when a BhutanApp user enters their CID.
   * Looks up DK Bank, finds any existing account with that CID, and merges
   * the caller into that account (transferring balance + auth methods).
   */
  @Post("link-cid")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Link CID to the current PWA user (merges with existing TMA account if found)" })
  @ApiBody({ type: LinkCidDto })
  async linkCid(@Body() dto: LinkCidDto, @Request() req: any) {
    return this.authService.linkCidAccount(req.user.userId, dto.cid);
  }

  /**
   * PWA phone verification — step 1: send a 6-digit OTP via SMS to the
   * supplied number. Stored 5 minutes in Redis. PWA users have no Telegram
   * chat, so SMS is the only delivery channel for security codes.
   */
  @Post("pwa/send-phone-otp")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  @ApiOperation({ summary: "Send SMS verification OTP to a phone number (PWA users)" })
  @ApiBody({ type: SendPwaPhoneOtpDto })
  async sendPwaPhoneOtp(
    @Body() dto: SendPwaPhoneOtpDto,
    @Request() req: any,
  ) {
    return this.authService.sendPwaPhoneOtp(req.user.userId, dto.phoneNumber);
  }

  /**
   * PWA phone verification — step 2: verify the OTP. On success the phone is
   * stored on the user (telegramPhoneHash + raw phoneNumber + telegramLinkedAt)
   * and can be used for withdrawal OTP delivery.
   */
  @Post("pwa/verify-phone-otp")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Verify the SMS OTP and mark phone as verified (PWA users)" })
  @ApiBody({ type: VerifyPwaPhoneOtpDto })
  async verifyPwaPhoneOtp(
    @Body() dto: VerifyPwaPhoneOtpDto,
    @Request() req: any,
  ) {
    return this.authService.verifyPwaPhoneOtp(req.user.userId, dto.otp);
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke the current JWT (logout)" })
  async logout(
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const { jti, exp, userId } = req.user as {
      jti?: string;
      exp?: number;
      userId: string;
    };
    if (jti && exp) {
      await this.authService.revokeToken(jti, exp, userId);
    }
    res.clearCookie("oro_auth", { path: "/" });
    return { ok: true };
  }

  /**
   * Returns whether the account for a given CID has a PWA password set.
   * Used by the PWA login form to decide whether to show the password field.
   * Does NOT leak any user data — only returns a boolean.
   */
  @Get("pwa-status")
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Check if a CID account has a PWA password set" })
  @ApiQuery({ name: "cid", required: true })
  async pwaStatus(@Query("cid") cid: string) {
    return this.authService.getPwaStatus(cid);
  }

  /**
   * Called from the TMA Settings page (JWT required).
   * Sets or changes the user's PWA login password.
   */
  @Post("set-pwa-password")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Set or change the PWA login password (TMA only)" })
  @ApiBody({ type: SetPwaPasswordDto })
  async setPwaPassword(@Body() dto: SetPwaPasswordDto, @Request() req: any) {
    await this.authService.setPwaPassword(req.user.userId, dto.password);
    return { ok: true, message: "PWA password updated successfully." };
  }

  /**
   * Called from the TMA when an already-authenticated Telegram user links their DK Bank CID.
   * Writes dkPhoneHash + DK fields onto the existing Telegram user row so phone
   * verification can proceed without creating a duplicate account.
   */
  @Post("link-dkbank")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Link DK Bank CID to the currently authenticated Telegram user (TMA use)",
  })
  @ApiBody({ type: DKBankAuthDto })
  async linkDKBank(@Body() dto: DKBankAuthDto, @Request() req: any) {
    return this.authService.loginWithDKBank(dto.cid, req.user.userId);
  }

  /**
   * Fallback verification for users whose Telegram phone differs from their DK Bank
   * registered phone (e.g. Bhutanese users abroad with a foreign SIM).
   * User proves account ownership by entering their full DK Bank account number,
   * which is only visible inside the bank app or passbook.
   */
  @Post("verify-dk-account")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Verify identity via DK Bank account number (fallback for abroad users)",
  })
  @ApiBody({ type: VerifyDKAccountDto })
  async verifyDKAccount(@Body() dto: VerifyDKAccountDto, @Request() req: any) {
    const telegramChatId = String(req.user.telegramId ?? req.user.userId);
    return this.telegramVerification.verifyByAccountNumber(
      req.user.userId,
      dto.accountNumber,
      telegramChatId,
    );
  }

  /**
   * Called from the TMA when the user shares their phone via Telegram.WebApp.requestContact().
   * Telegram signs the contact data with the bot token — we verify that signature here
   * before trusting the phone number. Security is equivalent to the bot /verify flow.
   */
  @Post("verify-phone-tma")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Verify phone from Telegram.WebApp.requestContact() inside the TMA",
  })
  @ApiBody({ type: VerifyPhoneTmaDto })
  async verifyPhoneTma(@Body() dto: VerifyPhoneTmaDto, @Request() req: any) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new BadRequestException("Bot not configured");

    // ── Verify Telegram-signed hash ────────────────────────────────────────────
    // Build the data-check string from the fields Telegram signed.
    // Only include non-empty fields, sorted alphabetically, excluding hash.
    const fields: Record<string, string> = {
      auth_date: String(dto.authDate),
      phone_number: dto.phoneNumber,
      user_id: String(dto.userId),
    };
    const dataCheckString = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("\n");

    const secretKey = createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const expectedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedHash, "hex");
    const receivedBuf = Buffer.from(dto.hash, "hex");
    const hashValid =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);

    if (!hashValid) {
      throw new UnauthorizedException(
        "Invalid contact data signature — possible tampering.",
      );
    }

    // ── Auth_date freshness check (5 minutes) ─────────────────────────────────
    const ageSeconds = Math.floor(Date.now() / 1000) - dto.authDate;
    if (ageSeconds > 300) {
      throw new BadRequestException("Contact data expired. Please try again.");
    }

    // ── userId in contact must match the authenticated user ───────────────────
    const telegramId = String(req.user.telegramId ?? req.user.userId);
    if (String(dto.userId) !== telegramId) {
      throw new UnauthorizedException(
        "Contact user_id does not match your Telegram account.",
      );
    }

    // ── Delegate to existing verification logic ───────────────────────────────
    return this.telegramVerification.linkTelegramPhone(
      telegramId, // telegramUserId
      telegramId, // telegramChatId (same as userId for TMA context)
      String(dto.userId), // contactUserId — must equal telegramUserId
      dto.phoneNumber,
    );
  }

  /**
   * Admin portal login — requires ADMIN_DEV_SECRET + TOTP (2FA).
   * Credentials go in the POST body so they never appear in server logs.
   * Rate-limited to 5 attempts per 5 minutes to prevent brute-force.
   */
  @Post("admin/login")
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @ApiOperation({
    summary: "Admin portal login (requires ADMIN_DEV_SECRET + TOTP)",
  })
  @ApiBody({ type: AdminLoginDto })
  async adminLogin(@Body() dto: AdminLoginDto) {
    const { secret, totp } = dto;
    const expected = process.env.ADMIN_DEV_SECRET;
    if (!expected) {
      throw new UnauthorizedException("Admin login is not configured");
    }
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(secret || "");
    const match =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);
    if (!match) {
      throw new UnauthorizedException("Wrong secret");
    }

    // TOTP 2FA — mandatory in production, optional in dev/staging
    const totpSecret = process.env.ADMIN_TOTP_SECRET;
    if (!totpSecret) {
      if (process.env.NODE_ENV === "production") {
        throw new UnauthorizedException(
          "ADMIN_TOTP_SECRET must be configured in production",
        );
      }
      Logger.warn("ADMIN_TOTP_SECRET is not set — admin login has no 2FA", "AuthController");
    }
    if (totpSecret) {
      if (!totp) throw new UnauthorizedException("TOTP code required");
      const { valid } = await totpVerify({ token: totp, secret: totpSecret });
      if (!valid)
        throw new UnauthorizedException("Invalid or expired TOTP code");
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
    if (!adminTelegramId) {
      throw new UnauthorizedException("ADMIN_TELEGRAM_ID not set in .env");
    }

    const user = JSON.stringify({
      id: Number(adminTelegramId),
      first_name: "Admin",
    });
    const auth_date = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      user,
      auth_date: String(auth_date),
      query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    });

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = createHmac("sha256", "WebAppData")
      .update(botToken || "")
      .digest();
    const hash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");
    params.set("hash", hash);

    const result = await this.authService.ensureAdminAndLogin(
      params.toString(),
    );
    return {
      token: result.token,
      user: result.user,
    };
  }

  /**
   * Manual Login Step 1: Request OTP
   * Fallback when Telegram initData login fails
   * Sends a 6-digit OTP to the user's Telegram ID
   */
  @Post("manual-login/request-otp")
  @HttpCode(200)
  @Public()
  @ApiOperation({
    summary:
      "Request OTP for manual login (fallback when Telegram initData fails)",
    description:
      "Sends a 6-digit OTP to the user's Telegram ID via bot. The user must provide their Telegram ID and DK Bank CID.",
  })
  @ApiBody({ type: ManualLoginRequestDto })
  async requestManualLoginOtp(@Body() dto: ManualLoginRequestDto) {
    await this.authService.requestManualLoginOtp(dto.telegramId, dto.cid);
    return {
      success: true,
      message: "OTP sent to your Telegram account. Valid for 5 minutes.",
    };
  }

  /**
   * Manual Login Step 2: Verify OTP and Login
   * Verifies the OTP and checks that the phone number matches DK Bank
   */
  @Post("manual-login/verify")
  @HttpCode(200)
  @Public()
  @ApiOperation({
    summary: "Verify OTP and complete manual login",
    description:
      "Validates the OTP and phone number. The phone number must match the DK Bank registered number. Returns a JWT token on success.",
  })
  @ApiBody({ type: ManualLoginVerifyDto })
  async verifyManualLogin(@Body() dto: ManualLoginVerifyDto) {
    return this.authService.verifyManualLogin(
      dto.telegramId,
      dto.cid,
      dto.otp,
      dto.phoneNumber,
    );
  }
}
