/**
 * EPL/UCL markets — match fixtures, the season stat boards (top scorer, assists,
 * yellow/red cards) and UCL bracket ties — all carry a subcategory prefixed
 * "epl-" or "ucl-". They settle constantly (one market per fixture, every
 * matchweek), so their resolution is deliberately NOT broadcast to the Telegram
 * channel: the per-fixture "Market Resolved" post was pure noise, and every
 * predictor already receives an individual result DM. Admin-created / one-off
 * markets still announce their winner to the channel.
 */
export function isEplUclSubcategory(subcategory?: string | null): boolean {
  const s = (subcategory ?? "").toLowerCase();
  return s.startsWith("epl-") || s.startsWith("ucl-");
}
