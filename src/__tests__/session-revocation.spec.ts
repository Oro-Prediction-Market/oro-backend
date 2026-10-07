// See auth-session-refresh.spec.ts: AuthController pulls in otplib's ESM.
jest.mock("otplib", () => ({ verify: jest.fn(() => false) }));

import { JwtService } from "@nestjs/jwt";
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AuthController } from "../auth/auth.controller";
import { AuthService } from "../auth/auth.service";
import { JwtStrategy } from "../auth/jwt.strategy";
import { issuedBeforeRevocation } from "../auth/session-revocation";
import { AuditAction, RoleType } from "../entities/audit-log.entity";

/**
 * "Sign out everywhere". Logout blacklists only the jti in hand, and sessions
 * slide, so a stolen cookie could be kept alive indefinitely. A per-user
 * cutoff ends every token issued up to that moment, wherever it is held.
 */

const SECRET = "test-secret-for-session-revocation";
const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: "8h" } });

function mint(userId = "user-1") {
  const token = jwt.sign({ sub: userId, isAdmin: false, jti: `j-${Math.random()}` });
  const { iat } = jwt.decode(token) as { iat: number };
  return { token, iat };
}

describe("issuedBeforeRevocation", () => {
  it("accepts everything while nothing has been revoked", () => {
    expect(issuedBeforeRevocation(1_000, null)).toBe(false);
    expect(issuedBeforeRevocation(undefined, undefined)).toBe(false);
  });

  it("rejects a token issued before the cutoff", () => {
    expect(issuedBeforeRevocation(1_000, new Date(1_000_500))).toBe(true);
  });

  // iat is whole seconds: a token minted earlier in the cutoff's own second
  // has the same iat as one minted later in it, so both must fail.
  it("rejects a token issued in the same second as the cutoff", () => {
    expect(issuedBeforeRevocation(1_000, new Date(1_000_000))).toBe(true);
    expect(issuedBeforeRevocation(1_000, new Date(1_000_999))).toBe(true);
  });

  it("accepts a token issued in a later second", () => {
    expect(issuedBeforeRevocation(1_001, new Date(1_000_999))).toBe(false);
  });

  it("fails closed on a token with no iat once a cutoff exists", () => {
    expect(issuedBeforeRevocation(undefined, new Date(1_000_000))).toBe(true);
  });
});

function serviceWith(user: any) {
  const service = Object.create(AuthService.prototype) as AuthService;
  const userRepo = {
    findOneBy: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue({ affected: user ? 1 : 0 }),
  };
  const auditLogRepo = {
    create: jest.fn((d: any) => d),
    save: jest.fn(async (d: any) => d),
  };
  Object.assign(service, {
    jwtService: jwt,
    redis: { get: jest.fn().mockResolvedValue(null) },
    userRepo,
    auditLogRepo,
  });
  return { service, userRepo, auditLogRepo };
}

describe("AuthService.getUserFromToken (the refresh path)", () => {
  // If this passed, a stolen cookie would be re-minted with a fresh iat and
  // outlive the cutoff.
  it("refuses a token issued before the user signed out everywhere", async () => {
    const { token, iat } = mint();
    const { service } = serviceWith({
      id: "user-1",
      sessionsRevokedAt: new Date(iat * 1000 + 500),
    });
    await expect(service.getUserFromToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("accepts a token issued after the cutoff", async () => {
    const { token, iat } = mint();
    const { service } = serviceWith({
      id: "user-1",
      sessionsRevokedAt: new Date(iat * 1000 - 1),
    });
    await expect(service.getUserFromToken(token)).resolves.toMatchObject({
      id: "user-1",
    });
  });
});

describe("JwtStrategy.validate (every guarded request)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ??= SECRET;
  });

  function strategyWith(user: any) {
    return new JwtStrategy(
      { findOneBy: jest.fn().mockResolvedValue(user) } as any,
      { get: jest.fn().mockResolvedValue(null) } as any,
    );
  }

  it("refuses a token issued before the cutoff", async () => {
    const strategy = strategyWith({ id: "user-1", sessionsRevokedAt: new Date(2_000_000) });
    await expect(
      strategy.validate({ sub: "user-1", jti: "j", iat: 1_999 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("lets through a token issued after it", async () => {
    const strategy = strategyWith({ id: "user-1", sessionsRevokedAt: new Date(2_000_000) });
    await expect(
      strategy.validate({ sub: "user-1", jti: "j", iat: 2_001 }),
    ).resolves.toMatchObject({ userId: "user-1" });
  });
});

describe("AuthService.revokeAllSessions", () => {
  it("stamps the cutoff and records who did it", async () => {
    const { service, userRepo, auditLogRepo } = serviceWith({ id: "user-1" });
    const before = Date.now();
    await service.revokeAllSessions("user-1", "user-1");

    const [where, patch] = userRepo.update.mock.calls[0];
    expect(where).toEqual({ id: "user-1" });
    expect(patch.sessionsRevokedAt.getTime()).toBeGreaterThanOrEqual(before);

    expect(auditLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AUTH_SESSIONS_REVOKED,
        adminId: "user-1",
        entityId: "user-1",
        roleType: RoleType.USER,
      }),
    );
  });

  it("refuses an unknown user rather than auditing nothing", async () => {
    const { service, auditLogRepo } = serviceWith(null);
    await expect(service.revokeAllSessions("ghost", "ghost")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(auditLogRepo.save).not.toHaveBeenCalled();
  });
});

describe("AuthController.logoutAll", () => {
  it("revokes every session for the caller and clears this cookie", async () => {
    const revokeAllSessions = jest.fn().mockResolvedValue(undefined);
    const controller = new AuthController(
      { revokeAllSessions } as any,
      {} as any,
      {} as any,
    );
    const res = { clearCookie: jest.fn() };

    expect(
      await controller.logoutAll({ user: { userId: "user-1" } } as any, res as any),
    ).toEqual({ ok: true });
    expect(revokeAllSessions).toHaveBeenCalledWith("user-1", "user-1");
    expect(res.clearCookie).toHaveBeenCalledWith("oro_auth", { path: "/" });
  });
});
