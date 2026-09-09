// otplib ships untranspiled ESM sources, and jest only transforms .ts under
// src/. Importing AuthController pulls it in transitively (for the TOTP check
// on another route), so stub it here rather than widening
// transformIgnorePatterns for every suite. Nothing below touches TOTP.
jest.mock("otplib", () => ({ verify: jest.fn(() => false) }));

import { JwtService } from "@nestjs/jwt";
import { UnauthorizedException } from "@nestjs/common";
import { AuthController } from "../auth/auth.controller";
import { AuthService } from "../auth/auth.service";

/**
 * The PWA holds its JWT in memory only, so every reload restores the session
 * through GET /auth/refresh and the httpOnly cookie. These cover the part that
 * decides how long a session actually lasts.
 */

const SECRET = "test-secret-for-session-refresh";

/** A real AuthService is 13 constructor arguments; these two methods need one. */
function serviceWithJwt(): AuthService {
  const service = Object.create(AuthService.prototype) as AuthService;
  (service as unknown as { jwtService: JwtService }).jwtService = new JwtService({
    secret: SECRET,
    signOptions: { expiresIn: "8h" },
  });
  return service;
}

function makeRes() {
  return { cookie: jest.fn() };
}

describe("AuthService.mintSessionToken", () => {
  it("signs a usable token carrying the caller's identity", () => {
    const service = serviceWithJwt();
    const token = service.mintSessionToken("user-1", true);

    const payload = new JwtService({ secret: SECRET }).verify(token) as {
      sub: string;
      isAdmin: boolean;
      jti: string;
      exp: number;
    };
    expect(payload.sub).toBe("user-1");
    expect(payload.isAdmin).toBe(true);
    expect(payload.jti).toEqual(expect.any(String));
  });

  // A shared jti would mean revoking one session revoked its successor too.
  it("gives every token its own jti", () => {
    const service = serviceWithJwt();
    const decode = (t: string) => new JwtService({ secret: SECRET }).decode(t) as { jti: string };
    expect(decode(service.mintSessionToken("user-1", false)).jti).not.toBe(
      decode(service.mintSessionToken("user-1", false)).jti,
    );
  });
});

describe("AuthService.tokenExpiresAt", () => {
  it("reads the expiry back as epoch milliseconds", () => {
    const service = serviceWithJwt();
    const expiresAt = service.tokenExpiresAt(
      service.mintSessionToken("user-1", false),
    );
    const eightHours = 8 * 60 * 60 * 1000;
    expect(expiresAt).not.toBeNull();
    expect(expiresAt! - Date.now()).toBeGreaterThan(eightHours - 5_000);
    expect(expiresAt! - Date.now()).toBeLessThanOrEqual(eightHours);
  });

  it("returns null rather than throwing on something undecodable", () => {
    expect(serviceWithJwt().tokenExpiresAt("not-a-jwt")).toBeNull();
  });
});

describe("AuthController.refreshSession", () => {
  const user = { id: "user-1", isAdmin: false } as any;

  function makeController(authService: Partial<AuthService>) {
    return new AuthController(authService as AuthService, {} as any, {} as any);
  }

  it("hands back a NEW token, not the one it was given", async () => {
    const real = serviceWithJwt();
    const original = real.mintSessionToken("user-1", false);

    const controller = makeController({
      getUserFromToken: jest.fn().mockResolvedValue(user),
      mintSessionToken: jest.fn(() => real.mintSessionToken("user-1", false)),
      tokenExpiresAt: (t: string) => real.tokenExpiresAt(t),
    });

    const res = makeRes();
    // Two tokens signed in the same second are identical, so hold the clock
    // apart by a second — this asserts a fresh token, not a fresh timestamp.
    await new Promise((r) => setTimeout(r, 1100));
    const out = (await controller.refreshSession(
      { cookies: { oro_auth: original } } as any,
      res as any,
    )) as { token: string | null };

    expect(out.token).not.toBeNull();
    expect(out.token).not.toBe(original);

    // The session slides: the replacement outlives what it replaced.
    expect(real.tokenExpiresAt(out.token!)!).toBeGreaterThan(
      real.tokenExpiresAt(original)!,
    );

    // And the cookie carries the replacement, not the original.
    expect(res.cookie).toHaveBeenCalledTimes(1);
    expect(res.cookie.mock.calls[0][1]).toBe(out.token);
  });

  // The bug that made the session a hard cap: a 7-day cookie could carry an
  // 8-hour JWT, so the browser kept sending a cookie whose contents had died.
  it("sizes the cookie to the token inside it", async () => {
    const real = serviceWithJwt();
    const controller = makeController({
      getUserFromToken: jest.fn().mockResolvedValue(user),
      mintSessionToken: jest.fn(() => real.mintSessionToken("user-1", false)),
      tokenExpiresAt: (t: string) => real.tokenExpiresAt(t),
    });

    const res = makeRes();
    await controller.refreshSession(
      { cookies: { oro_auth: "whatever" } } as any,
      res as any,
    );

    const [, token, options] = res.cookie.mock.calls[0];
    const drift = Math.abs(
      options.maxAge - (real.tokenExpiresAt(token)! - Date.now()),
    );
    expect(drift).toBeLessThan(2_000);
    expect(options.httpOnly).toBe(true);
  });

  it("reports no session when there is no cookie", async () => {
    const controller = makeController({
      getUserFromToken: jest.fn(),
      mintSessionToken: jest.fn(),
    });
    const res = makeRes();

    expect(await controller.refreshSession({ cookies: {} } as any, res as any)).toEqual(
      { token: null, user: null },
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });

  // Revocation must survive the change: a blacklisted or expired token fails
  // getUserFromToken, so refresh cannot mint a successor for it.
  it("does not mint a replacement for a token that no longer verifies", async () => {
    const mintSessionToken = jest.fn();
    const controller = makeController({
      getUserFromToken: jest
        .fn()
        .mockRejectedValue(new UnauthorizedException("Session has been revoked")),
      mintSessionToken,
    });
    const res = makeRes();

    expect(
      await controller.refreshSession(
        { cookies: { oro_auth: "revoked" } } as any,
        res as any,
      ),
    ).toEqual({ token: null, user: null });
    expect(mintSessionToken).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });
});
