import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduleModule } from "@nestjs/schedule";
import { User } from "../entities/user.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction } from "../entities/transaction.entity";
import { Position } from "../entities/position.entity";
import { Season } from "../entities/season.entity";
import { UsersController } from "./users.controller";
import { StreakService } from "./streak.service";
import { SeasonService } from "./season.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Payment, Transaction, Position, Season]),
    ScheduleModule.forRoot(),
  ],
  controllers: [UsersController],
  providers: [StreakService, SeasonService, TelegramSimpleService],
  exports: [StreakService, SeasonService],
})
export class UsersModule {}
