import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MarketsService } from "../markets/markets.service";
import { AdminController } from "../admin/admin.controller";

describe("MarketsService.setFeatured", () => {
  function build(affected: number) {
    const svc = Object.create(MarketsService.prototype) as any;
    svc.marketRepo = { update: jest.fn().mockResolvedValue({ affected }) };
    svc.redis = { del: jest.fn().mockResolvedValue(undefined) };
    return svc;
  }

  it("writes the isFeatured column and nothing else", async () => {
    const svc = build(1);
    await svc.setFeatured("m1", true);
    // Not a full-row save: a stale cached copy must never overwrite pools.
    expect(svc.marketRepo.update).toHaveBeenCalledWith(
      { id: "m1" },
      { isFeatured: true },
    );
  });

  it("clears the market and both feed caches so the pin shows at once", async () => {
    const svc = build(1);
    await svc.setFeatured("m1", false);
    expect(svc.redis.del).toHaveBeenCalledWith(
      "oro:cache:markets:all",
      "oro:cache:markets:all:live",
      "oro:cache:market:m1",
    );
  });

  it("404s for an unknown market without touching the cache", async () => {
    const svc = build(0);
    await expect(svc.setFeatured("nope", true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(svc.redis.del).not.toHaveBeenCalled();
  });
});

describe("AdminController.setMarketFeatured", () => {
  function build() {
    const ctrl = Object.create(AdminController.prototype) as any;
    ctrl.marketsService = {
      setFeatured: jest.fn().mockResolvedValue(undefined),
    };
    ctrl.auditService = { log: jest.fn().mockResolvedValue(undefined) };
    return ctrl;
  }
  const req = { user: { userId: "admin-1" }, ip: "127.0.0.1" };

  it("rejects anything but a boolean", async () => {
    const ctrl = build();
    for (const bad of [undefined, "true", 1, null]) {
      await expect(
        ctrl.setMarketFeatured("m1", { isFeatured: bad }, req),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(ctrl.marketsService.setFeatured).not.toHaveBeenCalled();
  });

  it("pins and records who did it", async () => {
    const ctrl = build();
    await expect(
      ctrl.setMarketFeatured("m1", { isFeatured: true }, req),
    ).resolves.toEqual({ id: "m1", isFeatured: true });
    expect(ctrl.marketsService.setFeatured).toHaveBeenCalledWith("m1", true);
    expect(ctrl.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        entityId: "m1",
        after: { isFeatured: true },
      }),
    );
  });
});
