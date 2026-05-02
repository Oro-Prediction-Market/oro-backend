import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { UserEvent } from "../entities/user-event.entity";

export interface TrackEventDto {
  eventType: string;
  sessionId?: string;
  platform?: string;
  meta?: Record<string, any>;
}

// Keys that must never be stored in event meta — Telegram auth material
const BLOCKED_META_KEYS = new Set([
  "tgWebAppData",
  "initData",
  "initDataRaw",
  "hash",
  "auth_date",
  "query_id",
]);

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(UserEvent)
    private readonly repo: Repository<UserEvent>,
  ) {}

  private sanitizeMeta(
    meta: Record<string, any> | undefined | null,
  ): Record<string, any> | null {
    if (!meta) return null;
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (!BLOCKED_META_KEYS.has(k)) clean[k] = v;
    }
    return Object.keys(clean).length ? clean : null;
  }

  async track(userId: string, dto: TrackEventDto): Promise<void> {
    await this.repo.save(
      this.repo.create({
        userId,
        eventType: dto.eventType,
        sessionId: dto.sessionId ?? null,
        platform: dto.platform ?? null,
        meta: this.sanitizeMeta(dto.meta),
      }),
    );
  }
}
