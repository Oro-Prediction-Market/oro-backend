import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserEvent } from "../entities/user-event.entity";
import { EventsService } from "./events.service";
import { EventsController } from "./events.controller";

@Module({
  imports: [TypeOrmModule.forFeature([UserEvent])],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
