import { Module } from "@nestjs/common";
import { FeedbackController } from "./feedback.controller";
import { EmailService } from "../shared/services/email.service";

// EmailService is not exported from a shared module — each consumer provides it
// (it only depends on the global ConfigService), matching AuthModule/UsersModule.
@Module({
  controllers: [FeedbackController],
  providers: [EmailService],
})
export class FeedbackModule {}
