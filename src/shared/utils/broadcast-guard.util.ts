/**
 * Decides whether this process is allowed to send a message to every user.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Developer laptops run against the production Telegram bot token. In September
 * 2026 unguarded cron jobs on a laptop, pointed at a stale development database,
 * sent roughly 4,000 real DMs to real users. Nothing in the code stopped it
 * because nothing in the code could tell the difference between that laptop and
 * production.
 *
 * An admin broadcast is the same hazard with the safety catch removed: one
 * request, every user, no recall. So the check lives here rather than in the
 * controller, and the fan-out consults it at its single chokepoint — any future
 * caller (a cron, a bot command, a one-off script) inherits it instead of having
 * to remember it.
 */

/**
 * Numeric ids of bots that are known NOT to be production — the part of
 * TELEGRAM_BOT_TOKEN before the colon, which is the bot's public user id and
 * not a secret.
 *
 * An allowlist of development bots rather than a denylist naming the production
 * one, because the two fail in opposite directions. A denylist has to recognise
 * the production token to stop it, so an UNKNOWN token — which is what the real
 * production token looks like on a machine that was never meant to have it —
 * sails through as "probably a test bot". This list fails the other way: a token
 * nobody registered here is refused, and the cost of being wrong is a developer
 * adding one line, not 2,199 people getting a DM.
 *
 * Hardcoded in source on purpose. Every environment-variable guard in this repo
 * can be defeated by a stale line in someone's `.env` — precisely the shape of
 * the September incident. Source cannot.
 *
 * To add a bot: get its token from BotFather, take the digits before the colon,
 * add it here with the @username in the comment.
 */
const NON_PRODUCTION_BOT_IDS = new Set<string>([
  "8924901746", // @betmahind_bot — "Bet machine", shared development bot
]);

export type FanOutVerdict =
  /** The production cluster. Send to everyone. */
  | { allowed: true; mode: "live" }
  /**
   * Not production, but the configured bot is not the production bot either.
   * The whole code path may run: Telegram will not let a bot open a conversation
   * with someone who never started it, so the audience is bounded by the
   * platform rather than by our code being correct.
   */
  | { allowed: true; mode: "test"; maxRecipients: number }
  | { allowed: false; reason: string };

/**
 * In test mode the audience query is capped at this many rows.
 *
 * Belt and braces: Telegram's 403-for-strangers behaviour is the real bound, but
 * a developer who has told a test bot to message them should not be able to
 * queue thousands of jobs by accident either.
 */
export const TEST_MODE_MAX_RECIPIENTS = 25;

/**
 * Whether this process may fan a message out to the whole user base.
 *
 * Allowed when EITHER the process is running in the production Kubernetes
 * runtime, OR the bot it would send from is not the production bot.
 *
 * Note what is deliberately NOT here: a bypass flag. `ALLOW_BROADCAST=true` set
 * once for a test and left in a `.env` is the same failure all over again. The
 * way to exercise this locally is to put a BotFather test-bot token in
 * TELEGRAM_BOT_TOKEN, which is a thing a developer keeps rather than a thing
 * they forget to unset.
 */
export function evaluateFanOut(
  env: NodeJS.ProcessEnv = process.env,
): FanOutVerdict {
  const botId = (env.TELEGRAM_BOT_TOKEN ?? "").split(":")[0]?.trim() ?? "";

  // Injected into every pod by the kubelet. Nothing else in src/ reads it, and
  // nobody sets it by hand — unlike NODE_ENV, which is baked into the image at
  // Dockerfile:36 and is therefore ALSO true for a developer running that image
  // locally while chasing a production bug. NODE_ENV alone is worth nothing here.
  const inCluster = !!env.KUBERNETES_SERVICE_HOST;

  if (inCluster && env.NODE_ENV === "production") {
    return { allowed: true, mode: "live" };
  }

  if (botId && NON_PRODUCTION_BOT_IDS.has(botId)) {
    return { allowed: true, mode: "test", maxRecipients: TEST_MODE_MAX_RECIPIENTS };
  }

  return {
    allowed: false,
    reason:
      "Broadcast fan-out is disabled outside the production cluster unless the " +
      "configured bot is a known development bot. Either this is the production " +
      "token on a machine that should not send to real users, or it is a new " +
      "test bot that needs adding to NON_PRODUCTION_BOT_IDS in " +
      "broadcast-guard.util.ts.",
  };
}

/**
 * A description of the machine that ran a broadcast, stored on the row.
 *
 * This is the column you are glad exists the next time something sends thousands
 * of DMs and nobody can say from where. The bot id is the public prefix only.
 */
export function runtimeFingerprint(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    nodeEnv: env.NODE_ENV ?? null,
    inCluster: !!env.KUBERNETES_SERVICE_HOST,
    botId: (env.TELEGRAM_BOT_TOKEN ?? "").split(":")[0] || null,
    hostname: env.HOSTNAME ?? null,
    at: new Date().toISOString(),
  };
}
