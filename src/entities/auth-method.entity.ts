import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "./user.entity";

export enum AuthProvider {
  TELEGRAM = "telegram",
  DKBANK = "dkbank",
}

@Index(["provider", "providerId"], { unique: true })
@Entity("auth_methods")
export class AuthMethod {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "enum", enum: AuthProvider, default: AuthProvider.TELEGRAM })
  provider: AuthProvider;

  @Column()
  providerId: string; // Telegram user ID

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, any>; // raw initData fields

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => User, (u) => u.authMethods, { onDelete: "CASCADE" })
  @JoinColumn()
  user: User;

  @Column()
  userId: string;
}
