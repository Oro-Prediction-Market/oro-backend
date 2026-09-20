import { ServiceUnavailableException } from "@nestjs/common";
import { DkMigrationFreezeGuard } from "../payment/guards/dk-migration-freeze.guard";
import { DK_MIGRATION_FREEZE_DEFAULT_END } from "../payment/dk-migration-window";

/**
 * Derived, not hardcoded: the end date is policy and has already moved once.
 * Tests that pinned it to "20 Sep 08:00" all broke when the freeze had to be
 * extended, which told us nothing except that a date had changed.
 */
const DEFAULT_END = new Date(DK_MIGRATION_FREEZE_DEFAULT_END);

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
    expect(body.windowEnd).toBe(DEFAULT_END.toISOString());
  });

  // Deposits came off this guard once it was clear they fail harmlessly, while
  // a withdrawal strands the user's balance. The message must not go on naming
  // a restriction that no longer exists — that sends people to support over a
  // Top Up screen that works.
  it("names only cash outs, since deposits are no longer frozen", () => {
    const guard = guardWith({});
    clockAt("2026-09-20T02:00:00+06:00");

    let thrown: ServiceUnavailableException | undefined;
    try {
      guard.canActivate();
    } catch (e) {
      thrown = e as ServiceUnavailableException;
    }

    const msg = String(
      (thrown!.getResponse() as Record<string, unknown>).message,
    );
    expect(msg).toMatch(/Cash outs are paused/);
    expect(msg).not.toMatch(/Top up/i);
  });

  // The morning the rail used to reopen. It no longer does: DK was still
  // broken at 08:00 on 20 Sep and four users were debited with nothing sent.
  it("stays shut past the original 20 Sep end", () => {
    const guard = guardWith({});
    clockAt("2026-09-20T08:00:00+06:00");
    expect(() => guard.canActivate()).toThrow(ServiceUnavailableException);
  });

  it("lets them through again the moment the window ends", () => {
    const guard = guardWith({});
    clockAt(new Date(DEFAULT_END.getTime()).toISOString());
    expect(guard.canActivate()).toBe(true);
  });

  // The whole point of a one-off window: no nightly repeat.
  it("stays open on later nights", () => {
    const guard = guardWith({});
    clockAt(new Date(DEFAULT_END.getTime() + 5 * 86_400_000).toISOString());
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
