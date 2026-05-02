import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";
import { Reconciliation } from "../entities/reconciliation.entity";
import { Settlement } from "../entities/settlement.entity";
import { Position } from "../entities/position.entity";
import { Transaction } from "../entities/transaction.entity";
import { Market } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { User } from "../entities/user.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Reconciliation,
      Settlement,
      Position,
      Transaction,
      Market,
      Outcome,
      User,
    ]),
  ],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
