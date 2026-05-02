import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export enum UserEventType {
  // Session
  APP_OPEN = "app.open",

  // Navigation
  PAGE_VIEW = "page.view",

  // Market engagement
  MARKET_VIEW = "market.view",
  BET_MODAL_OPEN = "bet.modal.open",

  // Social / virality
  SHARE_TAP = "share.tap",
  REFERRAL_SHARE = "referral.share",

  // Onboarding
  ONBOARDING_COMPLETE = "onboarding.complete",
}

@Entity("user_events")
@Index(["userId", "createdAt"])
export class UserEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  userId: string;

  /** Groups all events within a single app open. Generated client-side. */
  @Column({ type: "varchar", nullable: true })
  sessionId: string | null;

  @Column({ type: "varchar" })
  eventType: UserEventType | string;

  /** 'tma' | 'pwa' */
  @Column({ type: "varchar", nullable: true })
  platform: string | null;

  /**
   * Flexible payload per event type.
   * page.view → { page: "feed" | "leaderboard" | "challenges" | "wallet" | "profile" }
   * market.view / bet.modal.open → { marketId, marketTitle }
   * share.tap → { context: "bet" | "profile" | "market" }
   * referral.share → { channel: "telegram" | "copy" }
   */
  @Column({ type: "jsonb", nullable: true })
  meta: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;
}
