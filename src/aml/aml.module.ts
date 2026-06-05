import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AmlAlert } from "./entities/aml-alert.entity";
import { AmlReport } from "./entities/aml-report.entity";
import { AmlDetectorService } from "./aml-detector.service";
import { AmlReportService } from "./aml-report.service";
import { AmlService } from "./aml.service";
import { AmlController } from "./aml.controller";

@Module({
  imports: [TypeOrmModule.forFeature([AmlAlert, AmlReport])],
  providers: [AmlDetectorService, AmlReportService, AmlService],
  controllers: [AmlController],
  exports: [AmlService],
})
export class AmlModule {}
