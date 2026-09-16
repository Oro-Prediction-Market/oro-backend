import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * Telegram rejects a message over 4,096 characters. Reserving headroom for the
 * title, the bold tags around it and the blank line between means a body of
 * 3,500 can never be the thing that fails a send — better a form that refuses
 * than a broadcast that dies after 1,100 successful DMs.
 */
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 3_500;

export class SendAnnouncementDto {
  @ApiProperty({ description: "Headline, shown bold in the DM and as the notification title" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(ANNOUNCEMENT_TITLE_MAX)
  title: string;

  @ApiProperty({ description: "Body text. Plain text — HTML is escaped before sending." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(ANNOUNCEMENT_BODY_MAX)
  body: string;

  /**
   * Minted by the dashboard when the compose form OPENS. One opened form is one
   * intent, no matter how many times Send is pressed or how many times a timed-out
   * request is retried.
   */
  @ApiProperty({ description: "Idempotency key, generated when the compose form opened" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientRequestId: string;

  @ApiPropertyOptional({
    description:
      "Send anyway when an identical announcement went out in the last 10 minutes",
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
