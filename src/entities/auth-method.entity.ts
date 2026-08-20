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
  BHUTANAPP = "bhutanapp",
  /**
   * Email + password. The only provider where the password is the sole
   * credential rather than a convenience layered on an external identity —
   * so registration, login and reset each need their own rate limiting.
   *
   * `providerId` is the normalised (lowercased, trimmed) email address. The
   * existing unique index on (provider, providerId) then gives
   * one-account-per-email for free. Normalise on write, never on read: a
   * single un-normalised insert defeats the constraint.
   */
  EMAIL = "email",
  /**
   * Google Sign-In. The primary path for international accounts.
   *
   * `providerId` is Google's `sub` claim, **not** the email address. A person
   * can change the email on a Google account; `sub` is stable for its life, so
   * keying on email would silently detach the identity the day someone renames
   * their address.
   */
  GOOGLE = "google",
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
