import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TelegramGroup } from "../entities/telegram-group.entity";
import { GroupMembership } from "../entities/group-membership.entity";
import { User } from "../entities/user.entity";
import { LeaguesService } from "./leagues.service";
import { TelegramModule } from "../telegram/telegram.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([TelegramGroup, GroupMembership, User]),
    forwardRef(() => TelegramModule),
  ],
  providers: [LeaguesService],
  exports: [LeaguesService],
})
export class LeaguesModule {}
