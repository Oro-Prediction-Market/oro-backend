import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import { User } from "./user.entity";

@Entity("group_memberships")
@Index(["chatId", "userId"], { unique: true })
export class GroupMembership {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Telegram group chat ID this membership belongs to */
  @Column({ type: "varchar" })
  chatId: string;

  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @CreateDateColumn()
  joinedAt: Date;
}
