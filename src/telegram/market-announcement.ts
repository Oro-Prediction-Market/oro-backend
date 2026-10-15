/**
 * The channel post for a market announcement, as Telegram HTML.
 *
 * Kept apart from the controller so the one thing that can go wrong with it —
 * not fitting — is testable. A post with a photo carries its text as a
 * caption, and Telegram refuses a caption over 1,024 characters outright; a
 * plain message allows 4,096. A market with twenty-odd outcomes (Ballon d'Or)
 * runs past the caption limit, so the outcome list is shortened to fit, with a
 * "+N more" line, rather than the announcement failing.
 */

/** Telegram's limits, in characters. */
export const TELEGRAM_CAPTION_MAX = 1024;
export const TELEGRAM_MESSAGE_MAX = 4096;

/**
 * Escape text for Telegram's HTML parse mode. A title like "Bonds & Co" or
 * "<3 goals" otherwise makes Telegram reject the whole post.
 */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface AnnouncementInput {
  title: string;
  outcomes: string[];
  /** Already formatted for display, e.g. "Oct 26, 2026, 8:00 PM", or "TBD". */
  closesAt: string;
  link: string;
}

/**
 * The announcement text, at most `maxLength` characters long.
 *
 * Outcomes are dropped from the end, one at a time, until it fits. The count
 * of dropped ones is shown so nobody reads the list as complete. Tags count
 * toward the length here, which is stricter than Telegram (it counts the text
 * after parsing), so anything this returns fits.
 */
export function buildMarketAnnouncement(
  input: AnnouncementInput,
  maxLength: number,
): string {
  const head = `🚀 <b>NEW MARKET</b>\n\n📊 <b>${escapeTelegramHtml(input.title)}</b>\n\n`;
  const tail =
    `\n\n⏰ Closes: ${escapeTelegramHtml(input.closesAt)}\n\n` +
    `👉 <a href="${escapeTelegramHtml(input.link)}">Predict Now</a>`;
  const lines = input.outcomes.map((o) => `• ${escapeTelegramHtml(o)}`);

  const compose = (shown: number) => {
    const hidden = lines.length - shown;
    const list = [
      ...lines.slice(0, shown),
      ...(hidden > 0 ? [`+${hidden} more`] : []),
    ].join("\n");
    return `${head}🎲 <b>Outcomes:</b>\n${list}${tail}`;
  };

  for (let shown = lines.length; shown >= 0; shown--) {
    const text = compose(shown);
    if (text.length <= maxLength) return text;
  }
  // Even the title alone is too long: drop the outcome section entirely.
  return `${head.slice(0, Math.max(0, maxLength - tail.length))}${tail}`.slice(
    0,
    maxLength,
  );
}
