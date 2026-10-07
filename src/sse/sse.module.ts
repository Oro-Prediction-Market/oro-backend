import { Module, Global } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { SseService } from "./sse.service";
import { SseController } from "./sse.controller";
import { RedisModule } from "../redis/redis.module";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "../entities/user.entity";

@Global()
@Module({
  imports: [
    RedisModule,
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET", "oro_secret"),
      }),
    }),
  ],
  controllers: [SseController],
  providers: [SseService],
  exports: [SseService],
})
export class SseModule {}
