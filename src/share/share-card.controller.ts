import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Request,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { InjectRepository } from "@nestjs/typeorm";
import { Response } from "express";
import { Repository } from "typeorm";
import { JwtAuthGuard } from "../auth/guards";
import { User } from "../entities/user.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { MAX_CARD_BYTES, ShareCardService } from "./share-card.service";

/**
 * Staging a share card for Telegram to send as a real photo.
 *
 * Sharing used to go through the Web Share API, which works on iOS and does not
 * exist on Android inside Telegram's WebView — so every Android user was
 * sharing text with no image and no way to tell. This route plus
 * `shareMessage()` in the app replaces that with Telegram's own mechanism,
 * which behaves the same on both.
 */
@ApiTags("share")
@Controller("share")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ShareCardController {
  constructor(
    private readonly cards: ShareCardService,
    private readonly telegram: TelegramSimpleService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  @Post("card")
  @HttpCode(200)
  @ApiOperation({
    summary: "Stage a rendered share card and return a Telegram prepared-message id",
  })
  async stage(
    @Request() req: any,
    @Body()
    body: {
      image?: unknown;
      caption?: unknown;
      buttonText?: unknown;
      buttonUrl?: unknown;
    },
  ): Promise<{ preparedMessageId: string }> {
    // Accepts a bare base64 payload or a data: URL, since callers naturally have
    // whichever `canvas.toDataURL` / `toBlob` gave them.
    const raw = typeof body?.image === "string" ? body.image : "";
    const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
    if (!base64) throw new BadRequestException("An image is required");

    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      throw new BadRequestException("The image could not be decoded");
    }
    if (bytes.length === 0) throw new BadRequestException("The image is empty");
    if (bytes.length > MAX_CARD_BYTES)
      throw new BadRequestException("The image is too large");
    // Telegram accepts JPEG only, and rejects anything else at send time rather
    // than here — which would look like a share that quietly does nothing.
    if (!ShareCardService.looksLikeJpeg(bytes))
      throw new BadRequestException("The image must be a JPEG");

    const user = await this.userRepo.findOne({
      where: { id: req.user.userId },
      select: ["id", "telegramId"],
    });
    // `savePreparedInlineMessage` is addressed to a Telegram user. An account
    // that signed up through DK Bank or BhutanApp has no Telegram id, and there
    // is nothing to fall back to — the client handles this by using its native
    // share path instead.
    if (!user?.telegramId)
      throw new BadRequestException("This account is not linked to Telegram");
    const telegramId = Number(user.telegramId);
    if (!Number.isFinite(telegramId))
      throw new BadRequestException("This account is not linked to Telegram");

    const id = await this.cards.store(bytes);
    const photoUrl = this.cards.urlFor(id);
    if (!photoUrl) {
      // Without a public origin Telegram cannot fetch the card, and the prepared
      // message would be created pointing at nothing.
      throw new ServiceUnavailableException(
        "Sharing is unavailable: no public URL is configured",
      );
    }

    const caption =
      typeof body?.caption === "string" ? body.caption.slice(0, 1024) : "";
    const buttonText =
      typeof body?.buttonText === "string" ? body.buttonText.trim() : "";
    const buttonUrl =
      typeof body?.buttonUrl === "string" ? body.buttonUrl.trim() : "";

    const preparedMessageId = await this.telegram.savePreparedInlineMessage({
      userId: telegramId,
      photoUrl,
      caption,
      button:
        buttonText && buttonUrl
          ? { text: buttonText, url: buttonUrl }
          : undefined,
    });

    return { preparedMessageId };
  }
}

/**
 * The card itself, fetched by Telegram's servers.
 *
 * Its own controller with no class-level guard, following `SitemapController`
 * and `KycImageController`, rather than an authenticated controller with a
 * `@Public()` hole punched in it.
 */
@Controller("share-card")
export class ShareCardPublicController {
  constructor(private readonly cards: ShareCardService) {}

  // The `.jpg` suffix is part of the path because some fetchers infer type from
  // the extension before they read the Content-Type header.
  @Get(":id.jpg")
  async card(@Param("id") id: string, @Res() res: Response): Promise<void> {
    const bytes = await this.cards.read(id);
    // Also the expiry path: the Redis key is gone after 30 minutes and this is
    // a plain 404 rather than an error.
    if (!bytes) throw new NotFoundException();

    res.setHeader("Content-Type", "image/jpeg");
    // Helmet sets `Cross-Origin-Resource-Policy: same-origin` globally, which is
    // right everywhere else and fatal here: Telegram fetches this from its own
    // servers and would be refused. The same override, for the same reason, is
    // on the KYC image route. Nothing is protected by CORP here anyway — the id
    // is an unguessable UUID and the whole point is that Telegram can read it.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.end(bytes);
  }
}
