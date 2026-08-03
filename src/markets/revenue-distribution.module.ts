import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RevenueDistribution } from "../entities/revenue-distribution.entity";
import { Settlement } from "../entities/settlement.entity";
import { Market } from "../entities/market.entity";
import { RevenueDistributionService } from "./revenue-distribution.service";
import { PaymentModule } from "../payment/payment.module";

@Module({
  imports: [
    ConfigModule,
    // Settlement + Market are needed by reconcileMissingDistributions().
    TypeOrmModule.forFeature([RevenueDistribution, Settlement, Market]),
    PaymentModule,
  ],
  providers: [RevenueDistributionService],
  exports: [RevenueDistributionService],
})
export class RevenueDistributionModule {}
