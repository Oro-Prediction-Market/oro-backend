import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  HttpCode,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { IsString, IsOptional, IsObject } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { EventsService } from "./events.service";

class TrackEventBody {
  @ApiProperty()
  @IsString()
  eventType: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiProperty({ required: false, enum: ["tma", "pwa"] })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  meta?: Record<string, any>;
}

@ApiTags("Events")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("events")
export class EventsController {
  constructor(private readonly service: EventsService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: "Fire-and-forget user behavioural event" })
  async track(@Request() req: any, @Body() body: TrackEventBody): Promise<void> {
    await this.service.track(req.user.userId, body);
  }
}
