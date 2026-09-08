import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MarketComment } from "../entities/market-comment.entity";
import { MarketCommentFlag } from "../entities/market-comment-flag.entity";
import { MarketCommentLike } from "../entities/market-comment-like.entity";
import { Market } from "../entities/market.entity";
import { User } from "../entities/user.entity";
import { UsersModule } from "../users/users.module";
import { CommentsController } from "./comments.controller";
import { AdminCommentsController } from "./admin-comments.controller";
import { CommentsService } from "./comments.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MarketComment,
      MarketCommentFlag,
      MarketCommentLike,
      Market,
      User,
    ]),
    // For UserNotificationService — an author is told when a moderator removes
    // their comment rather than finding it silently gone.
    UsersModule,
  ],
  controllers: [CommentsController, AdminCommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
