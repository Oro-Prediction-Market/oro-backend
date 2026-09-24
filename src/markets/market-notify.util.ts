/**
 * Competition markets — match fixtures, the season stat boards (top scorer,
 * assists, yellow/red cards) and UCL bracket ties — all carry a subcategory
 * prefixed "epl-", "ucl-" or "unl-". They settle constantly (one market per
 * fixture, every matchweek), so their resolution is deliberately NOT broadcast
 * to the Telegram channel: the per-fixture "Market Resolved" post was pure
 * noise, and every predictor already receives an individual result DM.
 * Admin-created / one-off markets still announce their winner to the channel.
 *
 * The Nations League belongs here for the same reason and then some: a group
 * stage matchday is 27 matches settled within a few hours of each other, so
 * without this it would be the single loudest thing the channel has ever done.
 */
export function isCompetitionSubcategory(
  subcategory?: string | null,
): boolean {
  const s = (subcategory ?? "").toLowerCase();
  return (
    s.startsWith("epl-") || s.startsWith("ucl-") || s.startsWith("unl-")
  );
}
