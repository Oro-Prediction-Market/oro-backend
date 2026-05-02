import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ReportingService } from "./reporting.service";
import { ReportingController } from "./reporting.controller";
import { User } from "../entities/user.entity";
import { Market } from "../entities/market.entity";
import { Transaction } from "../entities/transaction.entity";
import { Dispute } from "../entities/dispute.entity";
import { AuditLog } from "../entities/audit-log.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Market,
      Transaction,
      Dispute,
      AuditLog,
    ]),
  ],
  controllers: [ReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
