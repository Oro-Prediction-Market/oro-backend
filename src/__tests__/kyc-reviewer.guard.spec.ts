import { ForbiddenException } from "@nestjs/common";
import { KycReviewerGuard } from "../kyc/kyc-reviewer.guard";

function ctx(user: any) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

function guardFor(dbUser: any) {
  const repo: any = { findOne: jest.fn().mockResolvedValue(dbUser) };
  return new KycReviewerGuard(repo);
}

describe("KycReviewerGuard", () => {
  it("admits a reviewer", async () => {
    const guard = guardFor({ id: "u1", isKycReviewer: true });
    await expect(guard.canActivate(ctx({ userId: "u1" }))).resolves.toBe(true);
  });

  it("does NOT admit an admin who is not a reviewer", async () => {
    // The whole reason the role exists. Admin means moving money and resolving
    // markets; this is permission to read strangers' passports. If one implied
    // the other, every admin would silently have an ability nobody granted.
    const guard = guardFor({ id: "u1", isKycReviewer: false, isAdmin: true });
    await expect(
      guard.canActivate(ctx({ userId: "u1", isAdmin: true })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects an unknown or unauthenticated caller", async () => {
    await expect(
      guardFor(null).canActivate(ctx({ userId: "ghost" })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardFor({ isKycReviewer: true }).canActivate(ctx(undefined)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
