import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("telegram_groups")
export class TelegramGroup {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Telegram group chat ID — stored as string to avoid JS bigint precision loss */
  @Column({ type: "varchar", unique: true })
  chatId: string;

  @Column({ type: "varchar", nullable: true })
  title: string | null;

  /** False when the bot has been removed from the group */
  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
