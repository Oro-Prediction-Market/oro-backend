# Audit Log RoleType Implementation

## Summary

Added support for tracking both admin and regular user actions in the audit log system by introducing a `RoleType` enum. The `roleType` is automatically determined from the user's `isAdmin` boolean field, while `entityType` remains as before for tracking affected entities (market, payment, etc.).

## Changes Made

### 1. **audit-log.entity.ts** - Added RoleType Enum & Field

- Created `RoleType` enum with values:
  - `ADMIN = "admin"` - for admin users (isAdmin = true)
  - `USER = "user"` - for regular users (isAdmin = false)
- Added `roleType` column to `AuditLog` entity (required field)
- Kept `entityType` as string for tracking affected entity types (market, payment, user, etc.)

### 2. **audit.service.ts** - Enhanced Service

- Updated `AuditParams` interface to require `isAdmin` boolean parameter
- `roleType` is automatically set based on `isAdmin` value:
  - `isAdmin = true` → `RoleType.ADMIN`
  - `isAdmin = false` → `RoleType.USER`
- Updated `FindPaginatedParams` interface to support filtering by `roleType`
- Modified `log()` method to automatically determine roleType from isAdmin
- Added filtering by `roleType` in `findPaginated()` method
- Added `getRoleTypeFromIsAdmin(isAdmin: boolean)` helper method
- Re-exported `RoleType` and `AuditAction` enums for convenience

### 3. **Database Migration** - AddRoleTypeToAuditLogs

- Created migration `1711100000012-AddRoleTypeToAuditLogs.ts`
- Adds `roleType` column with default value 'admin' for existing records
- Ensures backward compatibility with existing audit logs

## Usage Examples

### For Admin Users (isAdmin = true)

```typescript
await auditService.log({
  adminId: admin.id,
  adminUsername: admin.username,
  isAdmin: admin.isAdmin, // true -> RoleType.ADMIN
  action: AuditAction.MARKET_CREATE,
  entityType: "market",
  entityId: marketId,
});
```

### For Regular Users (isAdmin = false)

```typescript
await auditService.log({
  adminId: user.id,
  adminUsername: user.username,
  isAdmin: user.isAdmin, // false -> RoleType.USER
  action: AuditAction.PAYMENT_VIEW,
  entityType: "payment",
  entityId: paymentId,
});
```

### Filter Audit Logs by RoleType

```typescript
// Get only admin actions
const adminLogs = await auditService.findPaginated({
  roleType: RoleType.ADMIN,
  page: 1,
  limit: 50,
});

// Get only user actions
const userLogs = await auditService.findPaginated({
  roleType: RoleType.USER,
  page: 1,
  limit: 50,
});

// Get all (no role filter)
const allLogs = await auditService.findPaginated({
  roleType: "all",
  page: 1,
  limit: 50,
});
```

### Filter by Both RoleType and EntityType

```typescript
// Get admin actions on markets
const adminMarketLogs = await auditService.findPaginated({
  roleType: RoleType.ADMIN,
  entityType: "market",
  page: 1,
  limit: 50,
});

// Get user actions on payments
const userPaymentLogs = await auditService.findPaginated({
  roleType: RoleType.USER,
  entityType: "payment",
  page: 1,
  limit: 50,
});
```

## Helper Method

The `getRoleTypeFromIsAdmin(isAdmin: boolean)` method simplifies role type determination:

```typescript
const roleType = auditService.getRoleTypeFromIsAdmin(user.isAdmin);
// Returns RoleType.ADMIN if isAdmin = true
// Returns RoleType.USER if isAdmin = false
```

## Migration Required

Before deploying, run the migration:

```bash
# Development
npm run migration:run

# Or with yarn
yarn migration:run
```

## Breaking Changes

- `isAdmin` is now a **required** parameter in `AuditParams`
- Existing code must be updated to pass the `isAdmin` boolean

## Key Differences

- **roleType**: Indicates WHO performed the action (admin or user)
- **entityType**: Indicates WHAT was affected (market, payment, user, etc.)

## Files Modified

1. `/backend/src/entities/audit-log.entity.ts`
2. `/backend/src/admin/audit.service.ts`
3. `/backend/src/migrations/1711100000012-AddRoleTypeToAuditLogs.ts`
4. `/backend/src/admin/audit.service.example.ts` (updated examples)
