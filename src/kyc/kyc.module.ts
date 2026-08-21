import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "../entities/user.entity";
import { UserKycDocument } from "../entities/user-kyc-document.entity";
import { AuditLog } from "../entities/audit-log.entity";
import { AuditService } from "../admin/audit.service";
import { KycService } from "./kyc.service";
import {
  KycController,
  KycImageController,
  KycReviewController,
} from "./kyc.controller";
import { KycReviewerGuard } from "./kyc-reviewer.guard";
import {
  KycDocumentStorage,
  MinioKycDocumentStorage,
  UnconfiguredKycDocumentStorage,
  kycConfigReport,
} from "./kyc-document-storage";
import { Logger } from "@nestjs/common";

@Module({
  imports: [TypeOrmModule.forFeature([User, UserKycDocument, AuditLog])],
  controllers: [KycController, KycReviewController, KycImageController],
  providers: [
    KycService,
    KycReviewerGuard,
    AuditService,
    // MinIO when the cluster provides it, and a refusing stub otherwise.
    //
    // The stub is not a convenience: without it, a deployment missing its
    // MinIO credentials would take uploads, fail somewhere downstream, and
    // leave a user believing their passport was submitted. Refusing at the
    // door is the honest failure.
    //
    // `useFactory`, not `useClass`, and the difference is not cosmetic:
    // decorator arguments are evaluated when this file is *imported*, which
    // happens before `main.ts` calls `dotenv.config()`. A `useClass` choosing
    // on `process.env` therefore always saw an empty environment and always
    // picked the stub — a fully configured deployment refusing every upload,
    // with a log line blaming missing credentials that were in fact present.
    // A factory runs at container init, after the environment is loaded.
    {
      provide: KycDocumentStorage,
      useFactory: () => {
        const { ready, missing } = kycConfigReport();
        const log = new Logger("KycConfig");
        if (ready) {
          log.log("Identity verification is fully configured.");
        } else {
          log.warn(
            `Identity verification will refuse submissions. Missing: ${missing.join(", ")}`,
          );
        }

        return MinioKycDocumentStorage.isConfigured()
          ? new MinioKycDocumentStorage()
          : new UnconfiguredKycDocumentStorage();
      },
    },
  ],
  exports: [KycService],
})
export class KycModule {}
