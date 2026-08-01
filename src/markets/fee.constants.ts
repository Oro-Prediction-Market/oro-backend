/**
 * Oro's platform fee (a.k.a. "house edge"), in percent — the SINGLE source of
 * truth for the whole backend.
 *
 * Every market type, every creation default, and every settlement/odds fallback
 * MUST reference this constant so "Oro's fee" is never ambiguous. Historically
 * the value was hard-coded in several places at 5%, 8% and 10% (manual creation,
 * BTC/TER auto-markets, the settlement-engine fallback, the DB default, the LMSR
 * default), which made disclosure, reconciliation and testing inconsistent.
 * Standardised to a flat 10% for all markets.
 *
 * Note: existing markets keep whatever edge is already stored on their row —
 * this constant only governs NEW markets and any missing-value fallback.
 */
export const DEFAULT_HOUSE_EDGE_PCT = 10;
