import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLog, AuditAction, RoleType } from "../entities/audit-log.entity";

// Re-export for convenience
export { RoleType, AuditAction };

interface AuditParams {
  adminId: string;
  username?: string;
  isAdmin: boolean; // Use isAdmin boolean to determine roleType
  action: AuditAction | string;
  entityType?: string;
  entityId?: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  meta?: Record<string, any>;
  ipAddress?: string;
}

export interface FindPaginatedParams {
  page?: number;
  limit?: number;
  action?: string;
  adminId?: string;
  entityType?: string; // Filter by entity type
  roleType?: RoleType | string; // Filter by role type
  search?: string;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD (inclusive)
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  async log(params: AuditParams): Promise<void> {
    // console.log("[AuditService] Attempting to log audit:", {
    //   adminId: params.adminId,
    //   username: params.username,
    //   isAdmin: params.isAdmin,
    //   roleType: params.isAdmin ? RoleType.ADMIN : RoleType.USER,
    //   action: params.action,
    //   entityType: params.entityType,
    // });

    const entry = this.repo.create({
      adminId: params.adminId,
      username: params.username,
      roleType: params.isAdmin ? RoleType.ADMIN : RoleType.USER, // Determine from isAdmin boolean
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      payload: {
        before: params.before,
        after: params.after,
        meta: params.meta,
      },
      ipAddress: params.ipAddress,
    });

    // console.log("[AuditService] Created entry:", entry);

    // Fire-and-forget — never block the main request
    await this.repo
      .save(entry)
      .then(() => console.log("[AuditService] Successfully saved audit log"))
      .catch((err: any) => {
        console.error("[AuditService] Failed to write audit log:");
        console.error("Error message:", err?.message);
        console.error("Error details:", err);
        console.error("Full error:", JSON.stringify(err, null, 2));
      });
  }

  async findPaginated(params: FindPaginatedParams) {
    const limit = Math.min(params.limit ?? 50, 100);
    const page = Math.max(params.page ?? 1, 1);

    const qb = this.repo.createQueryBuilder("log");

    if (params.action && params.action !== "all") {
      qb.andWhere("log.action = :action", { action: params.action });
    }
    if (params.adminId) {
      qb.andWhere("log.adminId = :adminId", { adminId: params.adminId });
    }
    if (params.entityType && params.entityType !== "all") {
      qb.andWhere("log.entityType = :entityType", {
        entityType: params.entityType,
      });
    }
    if (params.roleType && params.roleType !== "all") {
      qb.andWhere("log.roleType = :roleType", { roleType: params.roleType });
    }
    if (params.search) {
      const s = `%${params.search.toLowerCase()}%`;
      qb.andWhere(
        "(LOWER(log.action) LIKE :s OR LOWER(COALESCE(log.adminUsername, '')) LIKE :s OR LOWER(COALESCE(log.entityId, '')) LIKE :s)",
        { s },
      );
    }
    if (params.from) {
      qb.andWhere("log.createdAt >= :from", { from: new Date(params.from) });
    }
    if (params.to) {
      // Make "to" inclusive by advancing to start of next day
      const toDate = new Date(params.to);
      toDate.setDate(toDate.getDate() + 1);
      qb.andWhere("log.createdAt < :to", { to: toDate });
    }

    qb.orderBy("log.createdAt", "DESC")
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, pages: Math.ceil(total / limit) || 1 };
  }

  /** Distinct admins who have ever performed an action — for filter dropdowns */
  async findDistinctAdmins(): Promise<
    Array<{ adminId: string; adminUsername: string | null }>
  > {
    return this.repo
      .createQueryBuilder("log")
      .select("log.adminId", "adminId")
      .addSelect("log.adminUsername", "adminUsername")
      .groupBy("log.adminId")
      .addGroupBy("log.adminUsername")
      .orderBy("log.adminUsername", "ASC", "NULLS LAST")
      .getRawMany();
  }

  // ── Legacy helpers (kept for existing callers) ────────────────────────────
  findAll(limit = 200) {
    return this.repo.find({
      order: { createdAt: "DESC" },
      take: Math.min(limit, 500),
    });
  }

  findByAdmin(adminId: string, limit = 100) {
    return this.repo.find({
      where: { adminId },
      order: { createdAt: "DESC" },
      take: Math.min(limit, 200),
    });
  }

  findByEntity(entityId: string) {
    return this.repo.find({
      where: { entityId },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Helper method to determine role type from isAdmin boolean
   * @param isAdmin - boolean indicating if the user is an admin
   * @returns RoleType enum value (ADMIN or USER)
   */
  getRoleTypeFromIsAdmin(isAdmin: boolean): RoleType {
    return isAdmin ? RoleType.ADMIN : RoleType.USER;
  }
}
