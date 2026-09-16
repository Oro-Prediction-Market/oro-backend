import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "../entities/user.entity";
import { RedisModule } from "../redis/redis.module";
import { TelegramModule } from "../telegram/telegram.module";
import {
  ShareCardController,
  ShareCardPublicController,
} from "./share-card.controller";
import { ShareCardService } from "./share-card.service";

@Module({
  imports: [TypeOrmModule.forFeature([User]), RedisModule, TelegramModule],
  controllers: [ShareCardController, ShareCardPublicController],
  providers: [ShareCardService],
})
export class ShareModule {}
