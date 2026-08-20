import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";

/**
 * Gate for the KYC review queue.
 *
 * Checks `isKycReviewer`, and deliberately does **not** accept `isAdmin` as a
 * substitute. Admin access means moving money and resolving markets; this is
 * permission to read strangers' passports. Letting one imply the other would
 * quietly hand every admin an ability nobody decided to give them.
 */
@Injectable()
export class KycReviewerGuard implements CanActivate {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = req.user?.userId ?? req.user?.sub;
    if (!userId) throw new ForbiddenException("Not authenticated");

    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ["id", "isKycReviewer"],
    });
    if (!user?.isKycReviewer) {
      throw new ForbiddenException(
        "KYC review requires the reviewer role",
      );
    }
    return true;
  }
}
