// Cross-source player-name matching for season "stat" markets (top scorer,
// assists, …). The live leaderboard (football-data) and a market's stored
// outcome labels can spell a name slightly differently, so dedup must be fuzzy.
// This mirrors the frontend hubs' `findStatOutcome` normalisation so the backend
// keeper and the app agree on who is already in the field.

/** Lowercase, strip accents/punctuation, collapse whitespace. */
export function normStatName(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastToken(s: string): string {
  const parts = normStatName(s).split(" ");
  return parts[parts.length - 1] ?? "";
}

/**
 * True when two names refer to the same player — either a full normalised match
 * or a shared surname (last token, length > 2 to avoid matching initials).
 */
export function statNamesMatch(a: string, b: string): boolean {
  const na = normStatName(a);
  const nb = normStatName(b);
  if (na && na === nb) return true;
  const la = lastToken(a);
  return la.length > 2 && la === lastToken(b);
}
