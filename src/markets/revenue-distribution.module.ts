import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RevenueDistribution } from "../entities/revenue-distribution.entity";
import { RevenueDistributionService } from "./revenue-distribution.service";
import { PaymentModule } from "../payment/payment.module";

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([RevenueDistribution]),
    PaymentModule,
  ],
  providers: [RevenueDistributionService],
  exports: [RevenueDistributionService],
})
export class RevenueDistributionModule {}
