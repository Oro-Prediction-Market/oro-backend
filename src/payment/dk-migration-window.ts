/**
 * DK Bank core-banking migration window.
 *
 * DK migrates overnight on 19 September 2026, and account numbers change in the
 * cutover. A deposit or withdrawal submitted mid-migration would be routed
 * against an account number that is on its way out, so both directions are
 * frozen for the duration rather than discovering afterwards which side the
 * money landed on. Balances, bets and payouts are untouched — this is only the
 * DK Bank cash rail.
 *
 * The dates below are the default. `DK_MIGRATION_FREEZE_START` and
 * `DK_MIGRATION_FREEZE_END` override them, so the window can be pushed out if
 * the cutover runs long, or lifted early with the literal `off`. Both are read
 * once at boot, so a change needs a restart but not a rebuild.
 *
 * Unset and empty both mean "use the default window", and only the explicit
 * `off` reopens the rail: a blank value in a copied .env is an accident far
 * more often than it is an instruction, and the accident must not be the one
 * that lets money move mid-migration.
 *
 * The offsets are written out (+06:00) so the window means the same instant
 * whatever `TZ` the process ends up with, even though main.ts pins it to
 * Asia/Thimphu.
 */

export const DK_MIGRATION_FREEZE_DEFAULT_START = "2026-09-19T23:00:00+06:00";

/**
 * Reopened by hand at 21:45 on 20 September, on the call of whoever owns this
 * decision. Everything below is the record of why it was shut, and what is
 * still true at the moment it was lifted.
 *
 * The rail first reopened on schedule at 08:00 on 20 September into a DK that
 * was still broken, and every withdrawal after that failed: four users,
 * Nu 2,374, debited with nothing sent. DK returns `2001` ("no response")
 * carrying the text "Fail due to rejection" on `/v1/initiate/transaction`, and
 * `/v1/transaction/status` — the endpoint the reconciler needs to resolve
 * exactly that ambiguity — crashes with a Python `NameError`
 * (`name 'requests_id' is not defined`). It was still failing identically at
 * 15:50, and was not re-verified before this reopening.
 *
 * So: while DK's status endpoint stays broken, a withdrawal that DK answers
 * ambiguously cannot be resolved by us at all. It parks in PROCESSING with the
 * debit intact and waits for a human with DK's statement. That is the risk
 * being carried here, deliberately.
 *
 * Re-freezing is a one-line change to the date below, or
 * `DK_MIGRATION_FREEZE_END` in the environment — the guard is still wired to
 * every withdrawal route, so nothing needs rebuilding to shut it again.
 *
 * Deposits are no longer behind this guard at all; see `payment.controller.ts`.
 */
export const DK_MIGRATION_FREEZE_DEFAULT_END = "2026-09-21T20:00:00+06:00";

export interface DkMigrationFreezeWindow {
  start: Date;
  end: Date;
}

export interface ResolvedDkMigrationFreeze {
  /** null only when the freeze has been explicitly switched off. */
  window: DkMigrationFreezeWindow | null;
  /** Set when an override was present but could not be used. */
  warning: string | null;
}

type FreezeEnv = {
  DK_MIGRATION_FREEZE_START?: string;
  DK_MIGRATION_FREEZE_END?: string;
};

/**
 * Reads the window out of the environment, falling back to the dates above.
 *
 * An override that does not parse is refused rather than silently ignored: a
 * typo in a date is far likelier to mean "someone meant to move the window"
 * than "someone meant to open the rail", so we keep the default window and let
 * the caller log loudly.
 */
export function resolveDkMigrationFreezeWindow(
  env: FreezeEnv = process.env,
): ResolvedDkMigrationFreeze {
  const rawStart = env.DK_MIGRATION_FREEZE_START;
  const rawEnd = env.DK_MIGRATION_FREEZE_END;

  // The one documented way to reopen the rail early. Nothing else does it.
  if (isOff(rawStart) || isOff(rawEnd)) {
    return { window: null, warning: null };
  }

  const defaults = {
    start: new Date(DK_MIGRATION_FREEZE_DEFAULT_START),
    end: new Date(DK_MIGRATION_FREEZE_DEFAULT_END),
  };

  const start = parseOverride(rawStart);
  const end = parseOverride(rawEnd);

  if (start === "invalid" || end === "invalid") {
    const bad = [
      start === "invalid" ? `DK_MIGRATION_FREEZE_START="${rawStart}"` : null,
      end === "invalid" ? `DK_MIGRATION_FREEZE_END="${rawEnd}"` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      window: defaults,
      warning:
        `Ignoring unparseable DK migration freeze override (${bad}) — ` +
        `expected an ISO 8601 instant such as ${DK_MIGRATION_FREEZE_DEFAULT_START}. ` +
        `Falling back to the default window.`,
    };
  }

  const window = {
    start: start ?? defaults.start,
    end: end ?? defaults.end,
  };

  if (window.start.getTime() >= window.end.getTime()) {
    return {
      window: defaults,
      warning:
        `Ignoring DK migration freeze override — start ` +
        `(${window.start.toISOString()}) is not before end ` +
        `(${window.end.toISOString()}). Falling back to the default window.`,
    };
  }

  return { window, warning: null };
}

export function isDkMigrationFreezeActive(
  window: DkMigrationFreezeWindow | null,
  now: Date = new Date(),
): boolean {
  if (!window) return false;
  const t = now.getTime();
  // Half-open: the rail reopens exactly at the end instant, not a tick later.
  return t >= window.start.getTime() && t < window.end.getTime();
}

/** Renders the window the way it is shown to a user, in Bhutan time. */
export function describeDkMigrationFreeze(
  window: DkMigrationFreezeWindow,
): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Thimphu",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${fmt.format(window.start)} to ${fmt.format(window.end)} (BTT)`;
}

function isOff(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "off";
}

/** null means "no override here, use the default". */
function parseOverride(raw: string | undefined): Date | null | "invalid" {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed;
}
