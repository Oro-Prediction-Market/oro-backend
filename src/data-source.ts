import { DataSource } from "typeorm";
import * as dotenv from "dotenv";
import { User } from "./entities/user.entity";
import { AuthMethod } from "./entities/auth-method.entity";
import { Market } from "./entities/market.entity";
import { Outcome } from "./entities/outcome.entity";
import { Position } from "./entities/position.entity";
import { Payment } from "./entities/payment.entity";
import { Transaction } from "./entities/transaction.entity";
import { Settlement } from "./entities/settlement.entity";
import { Dispute } from "./entities/dispute.entity";
import { DKGatewayAuthToken } from "./entities/dk-gateway-auth-token.entity";
import { PaymentOtp } from "./entities/payment-otp.entity";
import { AuditLog } from "./entities/audit-log.entity";
import { Challenge } from "./entities/challenge.entity";
import { Season } from "./entities/season.entity";
import { TelegramGroup } from "./entities/telegram-group.entity";
import { GroupMembership } from "./entities/group-membership.entity";
import { UserEvent } from "./entities/user-event.entity";

dotenv.config();

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5433,
  username: process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "oro_db",
  synchronize: false,
  logging: true,
  extra: {
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  },
  entities: [
    User,
    AuthMethod,
    Market,
    Outcome,
    Position,
    Payment,
    Transaction,
    Settlement,
    Dispute,
    DKGatewayAuthToken,
    PaymentOtp,
    AuditLog,
    Challenge,
    Season,
    TelegramGroup,
    GroupMembership,
    UserEvent,
  ],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
  subscribers: [],
});
