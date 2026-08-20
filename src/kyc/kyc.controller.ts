import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Response,
  StreamableFile,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/guards";
import { KycReviewerGuard } from "./kyc-reviewer.guard";
import { KycService } from "./kyc.service";
import { verifyKycImageUrl } from "./kyc-document-storage";
import { KycDocumentType } from "../entities/user-kyc-document.entity";

@ApiTags("kyc")
@Controller("kyc")
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  /**
   * Submit an identity document.
   *
   * The limit here is per source address and exists to bound **bandwidth**, not
   * identity: this is the one route that accepts several megabytes, so an
   * unbounded one is a cheap way to saturate the box.
   *
   * It is deliberately not a tight per-person cap. The tracker is the IP, and
   * an office, a university or a mobile carrier behind CGNAT is one address
   * shared by thousands — a cap of three an hour would mean three *people* an
   * hour could ever sign up from that network. Flooding the review queue is
   * already impossible by construction: `submit` refuses while a document is
   * pending, so a second one needs a reviewer's decision in between.
   */
  @Post("documents")
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60 * 60_000 } })
  @ApiOperation({ summary: "Submit an identity document for review" })
  async submit(
    @Request() req: any,
    @Body()
    body: {
      documentType: KycDocumentType;
      documentNumber: string;
      documentCountry: string;
      imageBase64: string;
      mimeType: string;
    },
  ) {
    return this.kyc.submit(req.user.userId, {
      documentType: body?.documentType,
      documentNumber: body?.documentNumber,
      documentCountry: body?.documentCountry,
      image: Buffer.from(body?.imageBase64 ?? "", "base64"),
      mimeType: body?.mimeType,
    });
  }

  @Get("status")
  @ApiOperation({ summary: "This account's KYC status" })
  async status(@Request() req: any) {
    return this.kyc.statusFor(req.user.userId);
  }
}

/**
 * Review queue. Separate controller so the reviewer guard covers every route
 * on it by construction, rather than route by route where one omission is a
 * passport leak.
 */
@ApiTags("kyc-review")
@Controller("admin/kyc")
@UseGuards(JwtAuthGuard, KycReviewerGuard)
export class KycReviewController {
  constructor(private readonly kyc: KycService) {}

  @Get("queue")
  @ApiOperation({ summary: "Pending documents, oldest first" })
  async queue(@Query("limit") limit?: string) {
    return this.kyc.listPending(Math.min(Number(limit) || 50, 200));
  }

  @Get("queue/health")
  @ApiOperation({ summary: "Queue depth and oldest pending age" })
  async health() {
    return this.kyc.queueHealth();
  }

  @Get("documents/:id")
  @ApiOperation({ summary: "Open one document — logged as a PII access" })
  async open(@Request() req: any, @Param("id") id: string) {
    return this.kyc.openForReview(req.user.userId, id, req.ip);
  }

  @Post("documents/:id/approve")
  @HttpCode(200)
  @ApiOperation({ summary: "Approve a document and unlock deposit" })
  async approve(@Request() req: any, @Param("id") id: string) {
    return this.kyc.approve(req.user.userId, id, req.ip);
  }

  @Post("documents/:id/reject")
  @HttpCode(200)
  @ApiOperation({ summary: "Reject with a reason the user will see" })
  async reject(
    @Request() req: any,
    @Param("id") id: string,
    @Body() body: { reason: string },
  ) {
    return this.kyc.reject(req.user.userId, id, body?.reason, req.ip);
  }
}


/**
 * The document image, on its own controller with **no class-level guards**.
 *
 * It cannot live on the reviewer controller: a browser loads this in an
 * `<img>` tag, which carries no Authorization header, so `JwtAuthGuard` and
 * `KycReviewerGuard` would both reject it. Authorisation is the signed,
 * short-lived link `openForReview` mints instead — unforgeable, bound to one
 * object key, and expiring in minutes.
 *
 * Splitting it out rather than marking one route public on the guarded
 * controller is deliberate: `@Public` disables only the JWT guard, so the
 * reviewer guard would still run and fail, and the next reader would have to
 * work out why.
 */
@ApiTags("kyc-review")
@Controller("admin/kyc")
export class KycImageController {
  constructor(private readonly kyc: KycService) {}

  @Get("image")
  @ApiOperation({ summary: "Stream a decrypted document image" })
  async image(
    @Query("key") key: string,
    @Query("expires") expires: string,
    @Query("sig") sig: string,
    @Response({ passthrough: true }) res: any,
  ) {
    const objectKey = verifyKycImageUrl(key, expires, sig);
    // 404 rather than 403 on a bad signature: whether a key exists is itself
    // information, and there is nothing here for an unauthorised caller to
    // learn from the difference.
    if (!objectKey) throw new NotFoundException();

    const { bytes, mimeType } = await this.kyc.readImage(objectKey);
    res.setHeader("Content-Type", mimeType);
    // Helmet sets `Cross-Origin-Resource-Policy: same-origin` globally, which
    // is right for everything else and fatal here: the admin app is served
    // from a different origin than the API, so the browser refuses to render
    // the image — silently, and only in a browser. curl and every test pass.
    //
    // Relaxed for this one response rather than globally. What protects the
    // document is the signature: an unguessable, short-lived token bound to
    // one object key. Anyone who can embed this already has the link, so CORP
    // was never what was keeping them out.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Never cached — the link expires, and a copy in a shared proxy would
    // outlive it.
    res.setHeader("Cache-Control", "no-store, private");
    return new StreamableFile(bytes);
  }
}
