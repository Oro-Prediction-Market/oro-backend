import {
  Controller,
  Post,
  Body,
  Get,
  Delete,
  Param,
  HttpCode,
  HttpStatus,
  HttpException,
  Request,
  UseGuards,
  Headers,
  BadRequestException,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from "@nestjs/swagger";
import { Throttle, SkipThrottle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard } from "../auth/guards";
import { DKBankPaymentService } from "./dkbank-payment.service";
import { DKGatewayService } from "./services/dk-gateway/dk-gateway.service";
import { BankLinkService } from "./bank-link.service";
import { RedisService } from "../redis/redis.service";
import { InitiatePaymentDto } from "./dto/initiate-payment.dto";
import { ConfirmPaymentDto } from "./dto/confirm-payment.dto";
import { ClientInquiryDto } from "./dto/client-inquiry.dto";
import {
  IsNumber,
  IsNotEmpty,
  IsString,
  IsUUID,
  MinLength,
  MaxLength,
} from "class-validator";
import { ApiProperty as Prop } from "@nestjs/swagger";

class InitiateWithdrawalDto {
  @Prop({ description: "Amount to withdraw in BTN", example: 200 })
  @IsNumber()
  @IsNotEmpty()
  amount: number;
}

class ConfirmWithdrawalDto {
  @Prop({ description: "Payment ID from withdrawal initiation" })
  @IsString()
  @IsNotEmpty()
  paymentId: string;

  @Prop({ description: "6-digit OTP sent via Telegram" })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(8)
  otp: string;
}

class LinkBankAccountDto {
  @Prop({ description: "Bhutanese CID (11 digits)", example: "10101000001" })
  @IsString()
  @IsNotEmpty()
  cid: string;
}

class VerifyBankLinkDto {
  @Prop({ description: "6-digit OTP sent to your DK Bank registered phone" })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(8)
  otp: string;
}

@ApiTags("Payments")
@Controller("payments")
@Throttle({ default: { limit: 8, ttl: 60_000 } }) // 8 req/min per IP on payment endpoints
export class PaymentController {
  constructor(
    private readonly configService: ConfigService,
    private readonly dkBankPaymentService: DKBankPaymentService,
    private readonly dkGatewayService: DKGatewayService,
    private readonly bankLinkService: BankLinkService,
    private readonly redis: RedisService,
  ) {}

  private async enforceRateLimit(
    key: string,
    max: number,
    windowSec: number,
  ): Promise<void> {
    const { allowed } = await this.redis.rateLimit(key, max, windowSec);
    if (!allowed) {
      throw new HttpException(
        `Too many requests. Max ${max} per ${windowSec}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  @Post("dkbank/initiate")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Step 1: Initiate DK Bank payment (sends OTP to customer phone)",
  })
  @ApiBody({ type: InitiatePaymentDto })
  @ApiResponse({
    status: 200,
    description: "Payment initiated — OTP sent to customer",
  })
  async initiateDKBankPayment(
    @Body() paymentData: InitiatePaymentDto,
    @Request() req: any,
  ) {
    // 5 payment initiations per minute per user
    await this.enforceRateLimit(`payment:initiate:${req.user.userId}`, 5, 60);
    return this.dkBankPaymentService.initiatePayment(req.user.userId, {
      amount: paymentData.amount,
      cid: paymentData.cid,
      description: paymentData.description,
      marketId: paymentData.marketId,
      disputeId: paymentData.disputeId,
    });
  }

  @Post("dkbank/confirm")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Step 2: Confirm DK Bank payment with OTP" })
  @ApiBody({ type: ConfirmPaymentDto })
  @ApiResponse({ status: 200, description: "Payment submitted to DK Bank" })
  async confirmDKBankPayment(
    @Body() dto: ConfirmPaymentDto,
    @Request() req: any,
  ) {
    // 5 OTP confirmation attempts per 15 minutes per user
    await this.enforceRateLimit(`payment:confirm:${req.user.userId}`, 5, 900);
    return this.dkBankPaymentService.confirmPayment(
      req.user.userId,
      dto.paymentId,
      dto.otp,
    );
  }

  @Post("dkbank/withdraw/initiate")
  @UseGuards(JwtAuthGuard)
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Step 1: Initiate withdrawal from Oro balance → DK Bank account",
  })
  @ApiBody({ type: InitiateWithdrawalDto })
  @ApiResponse({
    status: 200,
    description: "Withdrawal initiated — OTP sent to Telegram",
  })
  async initiateDKBankWithdrawal(
    @Body() dto: InitiateWithdrawalDto,
    @Request() req: any,
  ) {
    await this.enforceRateLimit(
      `withdrawal:initiate:${req.user.userId}`,
      3,
      60,
    );
    return this.dkBankPaymentService.initiateWithdrawal(req.user.userId, {
      amount: dto.amount,
    });
  }

  @Post("dkbank/withdraw/confirm")
  @UseGuards(JwtAuthGuard)
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Step 2: Confirm withdrawal with Telegram OTP" })
  @ApiBody({ type: ConfirmWithdrawalDto })
  @ApiResponse({
    status: 200,
    description: "Withdrawal confirmed and funds transferred",
  })
  async confirmDKBankWithdrawal(
    @Body() dto: ConfirmWithdrawalDto,
    @Request() req: any,
  ) {
    await this.enforceRateLimit(
      `withdrawal:confirm:${req.user.userId}`,
      5,
      900,
    );
    return this.dkBankPaymentService.confirmWithdrawal(
      req.user.userId,
      dto.paymentId,
      dto.otp,
    );
  }

  @Post("dkbank/account-inquiry")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Look up DK Bank account by CID — returns account number, name, and phone",
  })
  @ApiBody({ type: ClientInquiryDto })
  @ApiResponse({
    status: 200,
    description: "Account found",
    schema: {
      example: {
        accountNumber: "1234567890",
        accountName: "Sonam Tenzin",
        phoneNumber: "17123456",
      },
    },
  })
  async dkAccountInquiry(@Body() dto: ClientInquiryDto, @Request() req: any) {
    if (!dto?.id_number || dto.id_number.length < 11) {
      throw new BadRequestException("id_number must be 11 digits");
    }
    // Same rate limits as client-inquiry: 3/min per IP, 10/hr per CID
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    await this.enforceRateLimit(`account-inquiry:ip:${ip}`, 3, 60);
    await this.enforceRateLimit(`account-inquiry:cid:${dto.id_number}`, 10, 3600);

    const { accountNumber, accountName } =
      await this.dkGatewayService.lookupAccountByCID(dto.id_number);
    // phoneNumber is not returned — callers only need name + account number
    // to show a confirmation prompt. Returning the phone would expose PII to
    // any authenticated user who knows the target's CID.
    return { accountNumber, accountName };
  }

  @Post("client-inquiry")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "DK client inquiry by CID (requires auth)" })
  @ApiBody({ type: ClientInquiryDto })
  async clientInquiry(@Body() dto: ClientInquiryDto, @Request() req: any) {
    if (!dto?.id_type || dto.id_type !== "CID") {
      throw new BadRequestException(`id_type must be "CID"`);
    }
    if (!dto?.id_number || dto.id_number.length < 11) {
      throw new BadRequestException(`id_number must be 11 digits`);
    }
    // Per-IP limit: 3 per minute
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    await this.enforceRateLimit(`client-inquiry:ip:${ip}`, 3, 60);
    // Per-CID limit: 10 per hour — stops bulk scanning across rotating IPs
    await this.enforceRateLimit(`client-inquiry:cid:${dto.id_number}`, 10, 3600);

    const raw = await this.dkGatewayService.clientInquiry(dto);

    // Strip fields that must not leave the server: account number, phone, national ID.
    // Callers only need the name to show a confirmation prompt to the user.
    if (Array.isArray(raw?.response_data)) {
      raw.response_data = raw.response_data.map(
        ({ account_number: _a, phone_number: _p, national_id: _n, ...safe }: any) => safe,
      );
    }

    return raw;
  }

  @Get("dkbank/status/:paymentId")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Check DK Bank payment status" })
  async checkDKBankPaymentStatusOwned(
    @Param("paymentId") paymentId: string,
    @Request() req: any,
  ) {
    return this.dkBankPaymentService.getPaymentStatus(
      req.user.userId,
      paymentId,
    );
  }

  // DK webhook/callback endpoint (no user JWT required) — skip throttle, comes from DK Bank servers
  @Post("dkbank/webhook")
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "DK Bank webhook: update payment status" })
  async dkBankWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
  ) {
    const signature =
      headers["x-dk-signature"] ||
      headers["dk-signature"] ||
      headers["x-dk-signature-v1"];
    return this.dkBankPaymentService.handleWebhook(payload, signature);
  }

  // Backward-compatible alias — skip throttle, comes from DK Bank servers
  @Post("dkbank/callback")
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  async dkBankCallback(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
  ) {
    const signature =
      headers["x-dk-signature"] ||
      headers["dk-signature"] ||
      headers["x-dk-signature-v1"];
    return this.dkBankPaymentService.handleWebhook(payload, signature);
  }

  @Get("methods")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Get available payment methods" })
  @ApiResponse({ status: 200, description: "Available payment methods" })
  async getPaymentMethods() {
    return {
      methods: [
        {
          id: "dkbank",
          name: "DK Bank",
          type: "dkbank",
          currency: "BTN",
          enabled: true,
          minAmount: 50,
          maxAmount: 15000,
          icon: "🏦",
        },
        {
          id: "ton",
          name: "TON Wallet",
          type: "ton",
          currency: "USDT",
          enabled: true,
          minAmount: 0.5,
          maxAmount: 100,
          icon: "💎",
        },
        {
          id: "credits",
          name: "Oro Credits",
          type: "credits",
          currency: "CREDITS",
          enabled: true,
          minAmount: 1,
          icon: "🪙",
        },
      ],
    };
  }

  @Get("config")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Get payment configuration" })
  @ApiResponse({ status: 200, description: "Payment configuration" })
  async getPaymentConfig() {
    const baseUrl = this.configService.get("DK_BASE_URL") || "";
    return {
      dkBank: {
        // Public/non-secret flags only; do not leak DK internal endpoints/beneficiary identifiers.
        isStaging: baseUrl.includes("sit"),
      },
      environment: process.env.NODE_ENV || "development",
    };
  }

  // ── Bank account linking ────────────────────────────────────────────────────

  @Post("bank/link")
  @UseGuards(JwtAuthGuard)
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Step 1: Link DK Bank account by CID — sends OTP to DK-registered phone",
  })
  @ApiBody({ type: LinkBankAccountDto })
  @ApiResponse({
    status: 200,
    description: "OTP sent to DK-registered phone",
    schema: {
      example: {
        accountName: "Sonam Tenzin",
        maskedPhone: "****5678",
        requiresOtp: true,
      },
    },
  })
  async linkBankAccount(
    @Body() dto: LinkBankAccountDto,
    @Request() req: any,
  ) {
    await this.enforceRateLimit(`bank:link:${req.user.userId}`, 5, 300);
    return this.bankLinkService.linkBankAccount(req.user.userId, dto.cid);
  }

  @Post("bank/verify")
  @UseGuards(JwtAuthGuard)
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Step 2: Verify DK Bank OTP to complete bank account linking",
  })
  @ApiBody({ type: VerifyBankLinkDto })
  @ApiResponse({ status: 200, description: "Bank account linked successfully" })
  async verifyBankLink(
    @Body() dto: VerifyBankLinkDto,
    @Request() req: any,
  ) {
    await this.enforceRateLimit(`bank:verify:${req.user.userId}`, 8, 300);
    const account = await this.bankLinkService.verifyBankLink(
      req.user.userId,
      dto.otp,
    );
    return {
      id: account.id,
      cid: account.cid,
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      maskedPhone: account.bankPhone
        ? account.bankPhone.slice(0, -4).replace(/\d/g, "*") +
          account.bankPhone.slice(-4)
        : null,
      isDefault: account.isDefault,
      verifiedAt: account.verifiedAt,
    };
  }

  @Get("bank/accounts")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "List verified linked bank accounts" })
  @ApiResponse({ status: 200, description: "Linked accounts" })
  async getLinkedAccounts(@Request() req: any) {
    const accounts = await this.bankLinkService.getLinkedAccounts(
      req.user.userId,
    );
    return accounts.map((a) => ({
      id: a.id,
      cid: a.cid,
      accountNumber: a.accountNumber,
      accountName: a.accountName,
      maskedPhone: a.bankPhone
        ? a.bankPhone.slice(0, -4).replace(/\d/g, "*") + a.bankPhone.slice(-4)
        : null,
      isDefault: a.isDefault,
      verifiedAt: a.verifiedAt,
    }));
  }

  @Delete("bank/accounts/:accountId")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Unlink a bank account" })
  async unlinkBankAccount(
    @Param("accountId") accountId: string,
    @Request() req: any,
  ) {
    await this.bankLinkService.unlinkAccount(req.user.userId, accountId);
  }
}
