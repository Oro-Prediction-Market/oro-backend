import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Settlement } from "../entities/settlement.entity";
import { Dispute } from "../entities/dispute.entity";
import { Position } from "../entities/position.entity";
import { User } from "../entities/user.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction } from "../entities/transaction.entity";
import { AuditLog } from "../entities/audit-log.entity";
import { AdminController } from "./admin.controller";
import { MarketsModule } from "../markets/markets.module";
import { FixturesService } from "./fixtures.service";
import { AuditService } from "./audit.service";
import { TelegramModule } from "../telegram/telegram.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Settlement,
      Dispute,
      Position,
      User,
      Payment,
      Transaction,
      AuditLog,
    ]),
    MarketsModule,
    TelegramModule,
  ],
  controllers: [AdminController],
  providers: [FixturesService, AuditService],
  exports: [AuditService],
})
export class AdminModule {}
