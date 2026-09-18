import { ServiceUnavailableException } from "@nestjs/common";
import { DkMigrationFreezeGuard } from "../payment/guards/dk-migration-freeze.guard";

/**
 * The guard resolves its window in the constructor, so each case builds a guard
 * with the environment it wants and then moves the clock under it.
 */
function guardWith(env: Record<string, string | undefined>) {
  const saved = {
    start: process.env.DK_MIGRATION_FREEZE_START,
    end: process.env.DK_MIGRATION_FREEZE_END,
  };
  applyEnv(env);
  try {
    return new DkMigrationFreezeGuard();
  } finally {
    applyEnv({
      DK_MIGRATION_FREEZE_START: saved.start,
      DK_MIGRATION_FREEZE_END: saved.end,
    });
  }
}

function applyEnv(env: Record<string, string | undefined>) {
  for (const key of ["DK_MIGRATION_FREEZE_START", "DK_MIGRATION_FREEZE_END"]) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("DkMigrationFreezeGuard", () => {
  afterEach(() => jest.useRealTimers());

  const clockAt = (iso: string) => {
    jest.useFakeTimers().setSystemTime(new Date(iso));
  };

  it("lets deposits and withdrawals through before the cutover", () => {
    const guard = guardWith({});
    clockAt("2026-09-19T22:59:00+06:00");
    expect(guard.canActivate()).toBe(true);
  });

  it("refuses them during the window", () => {
    const guard = guardWith({});
    clockAt("2026-09-20T02:00:00+06:00");
    expect(() => guard.canActivate()).toThrow(ServiceUnavailableException);
  });

  it("explains itself in a message the wallet can show as-is", () => {
    const guard = guardWith({});
    clockAt("2026-09-20T02:00:00+06:00");

    let thrown: ServiceUnavailableException | undefined;
    try {
      guard.canActivate();
    } catch (e) {
      thrown = e as ServiceUnavailableException;
    }

    const body = thrown!.getResponse() as Record<string, unknown>;
    expect(thrown!.getStatus()).toBe(503);
    expect(body.error).toBe("DK_MIGRATION_FREEZE");
    expect(String(body.message)).toMatch(/DK Bank/);
    // Says the money is safe — the first thing anyone hitting this will wonder.
    expect(String(body.message)).toMatch(/balance and open predictions are unaffected/);
    expect(body.windowEnd).toBe("2026-09-20T02:00:00.000Z");
  });

  it("lets them through again the moment the window ends", () => {
    const guard = guardWith({});
    clockAt("2026-09-20T08:00:00+06:00");
    expect(guard.canActivate()).toBe(true);
  });

  // The whole point of a one-off window: no nightly repeat.
  it("stays open on later nights", () => {
    const guard = guardWith({});
    clockAt("2026-09-25T02:00:00+06:00");
    expect(guard.canActivate()).toBe(true);
  });

  it("honours an extended end when the cutover runs long", () => {
    const guard = guardWith({
      DK_MIGRATION_FREEZE_END: "2026-09-20T11:00:00+06:00",
    });
    clockAt("2026-09-20T09:30:00+06:00");
    expect(() => guard.canActivate()).toThrow(ServiceUnavailableException);
  });

  it("reopens the rail on an explicit `off`", () => {
    const guard = guardWith({ DK_MIGRATION_FREEZE_START: "off" });
    clockAt("2026-09-20T02:00:00+06:00");
    expect(guard.canActivate()).toBe(true);
  });

  it("keeps the rail shut when the override is blank", () => {
    const guard = guardWith({
      DK_MIGRATION_FREEZE_START: "",
      DK_MIGRATION_FREEZE_END: "",
    });
    clockAt("2026-09-20T02:00:00+06:00");
    expect(() => guard.canActivate()).toThrow(ServiceUnavailableException);
  });
});
