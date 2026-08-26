/**
 * Classification of a DK Bank textual transaction status.
 *
 * DK reports outcomes as free text ("SUCCESSFUL", "TRANSACTION UNSUCCESSFUL",
 * "PENDING AT BENEFICIARY BANK", …), so every consumer has to pattern-match.
 * Doing that ad hoc is how `"UNSUCCESSFUL".includes("SUCCESS")` shipped: a
 * naive success-first substring test reads every rejection as a confirmation.
 * One shared classifier keeps the failure vocabulary in a single place.
 */
export type DkStatusVerdict = "success" | "failed" | "pending";

/** Words that mean "no money moved" and that may *contain* "SUCCESS". */
const FAILURE_MARKERS = [
  "FAIL",
  "UNSUCCESS",
  "NOT SUCCESS",
  "REJECT",
  "DECLINE",
  "REVERSED",
  "CANCEL",
] as const;

/**
 * Map a DK status string onto a verdict.
 *
 * Failure is always tested first: a status that matches both (e.g.
 * "UNSUCCESSFUL") is a failure. Anything unrecognised stays `pending` — the
 * caller must treat that as "still in flight", never as a terminal state.
 */
export function classifyDkStatus(status: string | null | undefined) {
  const s = (status || "").toUpperCase();
  if (FAILURE_MARKERS.some((m) => s.includes(m))) return "failed";
  if (s.includes("SUCCESS")) return "success";
  return "pending";
}
