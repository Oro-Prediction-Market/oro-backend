import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

@Entity("dk_gateway_auth_tokens")
export class DKGatewayAuthToken {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  // DK-issued access token (bearer token)
  @Index()
  @Column({ type: "text", name: "accesstoken" })
  accessToken: string;

  @Column({ type: "text", name: "refreshtoken", nullable: true })
  refreshToken: string | null;

  @Index()
  @Column({ type: "timestamp", name: "expiresat" })
  expiresAt: Date;

  @CreateDateColumn({ type: "timestamp", name: "createdat" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamp", name: "updatedat" })
  updatedAt: Date;
}

