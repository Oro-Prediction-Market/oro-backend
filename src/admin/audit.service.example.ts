/**
 * Example: How to use the AuditService with RoleType based on isAdmin
 *
 * This file demonstrates how to log actions for both admin and regular users
 * The roleType is automatically determined from the user's isAdmin boolean
 */

import { AuditService, RoleType, AuditAction } from "./audit.service";
import { User } from "../entities/user.entity";

// Example usage in a controller or service

class ExampleUsage {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Example 1: Log an action for an admin user
   * roleType will be set to RoleType.ADMIN
   */
  async logAdminAction(admin: User, action: AuditAction) {
    await this.auditService.log({
      adminId: admin.id,
      username: admin.username || undefined,
      isAdmin: admin.isAdmin, // true -> RoleType.ADMIN
      action: action,
      entityType: "market",
      entityId: "some-market-id",
      ipAddress: "127.0.0.1",
    });
  }

  /**
   * Example 2: Log an action for a regular user
   * roleType will be set to RoleType.USER
   */
  async logUserAction(user: User, action: AuditAction) {
    await this.auditService.log({
      adminId: user.id,
      username: user.username || undefined,
      isAdmin: user.isAdmin, // false -> RoleType.USER
      action: action,
      entityType: "payment",
      entityId: "some-payment-id",
      ipAddress: "127.0.0.1",
    });
  }

  /**
   * Example 3: Using the helper method
   */
  async logWithHelper(user: User) {
    const roleType = this.auditService.getRoleTypeFromIsAdmin(user.isAdmin);

    await this.auditService.log({
      adminId: user.id,
      isAdmin: user.isAdmin,
      action: AuditAction.USER_VIEW,
      entityType: "user",
      entityId: user.id,
    });
  }

  /**
   * Example 4: Filter audit logs by role type (admin actions)
   */
  async getAdminAuditLogs() {
    return this.auditService.findPaginated({
      page: 1,
      limit: 50,
      roleType: RoleType.ADMIN,
    });
  }

  /**
   * Example 5: Filter audit logs for regular user actions
   */
  async getUserAuditLogs() {
    return this.auditService.findPaginated({
      page: 1,
      limit: 50,
      roleType: RoleType.USER,
    });
  }

  /**
   * Example 6: Filter by entity type (market, payment, etc.)
   */
  async getMarketAuditLogs() {
    return this.auditService.findPaginated({
      page: 1,
      limit: 50,
      entityType: "market",
    });
  }

  /**
   * Example 7: Combine filters - admin actions on markets
   */
  async getAdminMarketLogs() {
    return this.auditService.findPaginated({
      page: 1,
      limit: 50,
      roleType: RoleType.ADMIN,
      entityType: "market",
    });
  }

  /**
   * Example 8: Get all audit logs (no filters)
   */
  async getAllAuditLogs() {
    return this.auditService.findPaginated({
      page: 1,
      limit: 50,
      roleType: "all",
      entityType: "all",
    });
  }
}

export default ExampleUsage;
