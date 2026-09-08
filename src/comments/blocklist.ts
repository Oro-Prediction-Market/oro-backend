/**
 * A word blocklist for comment bodies.
 *
 * WHAT THIS IS AND IS NOT. This catches lazy English profanity typed straight
 * into the box, including the obvious evasions (spacing, repeated letters,
 * leetspeak). That is all it does.
 *
 * It does NOT meaningfully filter Oro's actual users, who write Dzongkha,
 * romanised Dzongkha and English in the same sentence. Romanised Dzongkha has
 * no standardised spelling, so there is no fixed string to match against, and
 * any list that tried would produce false positives on ordinary words. Treat
 * this as a speed bump that stops the laziest abuse. **The flag queue in
 * oro-admin is the actual moderation mechanism** — do not let the existence of
 * this file create confidence that comments are filtered.
 *
 * The list lives alone in this file precisely so it can be edited by a
 * moderator's request without touching feature code.
 */

/**
 * Terms are matched as WHOLE WORDS against the normalised body — never as
 * substrings. Substring matching is the classic way these lists go wrong: on a
 * prediction market "analysis" and "analyst" are everyday words (Analyst is one
 * of our own reputation tiers), and a prefix match on a shorter term would
 * reject them. The cost of whole-word matching is that derived forms have to be
 * listed explicitly, which is why "fucking" and "shithead" appear below.
 */
const BLOCKED_TERMS: string[] = [
  "arsehole",
  "asshole",
  "bastard",
  "bitch",
  "bollocks",
  "cock",
  "cunt",
  "dick",
  "dickhead",
  "faggot",
  "fuck",
  "fucker",
  "fucking",
  "motherfucker",
  "nigga",
  "nigger",
  "paki",
  "penis",
  "prick",
  "pussy",
  "rape",
  "retard",
  "shit",
  "shithead",
  "shitty",
  "slut",
  "twat",
  "vagina",
  "whore",
  "wanker",
];

/**
 * Common character substitutions used to slip a term past a plain string match.
 * Applied after lowercasing, before collapsing repeats.
 */
const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
  "+": "t",
};

/**
 * Fold a body down to a form the term list can be matched against:
 * lowercase, accents stripped, leetspeak mapped back to letters, runs of the
 * same letter collapsed ("fuuuuck" -> "fuck"), and every non-letter turned into
 * a single space so "f.u.c.k" and "f u c k" both close up.
 *
 * Exported for the tests, which assert on the folding rather than only the
 * verdict.
 */
function fold(input: string): string {
  const lowered = input
    .toLowerCase()
    // Decompose accents (é -> e + combining acute) and drop the marks.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  return Array.from(lowered)
    .map((ch) => LEET_MAP[ch] ?? ch)
    .join("")
    .replace(/(.)\1+/g, "$1");
}

export function normalise(input: string): string {
  return (
    fold(input)
      // Anything that is not a letter becomes a separator, so punctuation and
      // zero-width padding cannot break a term apart.
      .replace(/[^a-z]+/g, " ")
      // A term split by separators ("f u c k") closes back up only when every
      // fragment is a single letter; joining unconditionally would merge
      // ordinary adjacent words into false positives.
      .replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (run) => run.replace(/ /g, ""))
      .trim()
  );
}

/** Characters people use to blank out a letter: f*ck, sh#t, c-nt. */
const CENSOR_CHARS = "*#@$%&+?!.\\-_~^";

/**
 * A term with any letter after the first blanked out by a censor character.
 *
 * The first letter must be literal. Without that anchor a term of N letters
 * would be matched by N censor characters — someone politely typing "****"
 * would be rejected — and evasions keep the first letter anyway, because the
 * point is to stay readable.
 *
 * Both ends are anchored on a word boundary, so this stays whole-word like the
 * plain path: it must not turn into a prefix match.
 */
function censoredPattern(term: string): RegExp {
  const [first, ...rest] = Array.from(term);
  const body = rest
    .map((ch) => `(?:${ch}|[${CENSOR_CHARS}])`)
    .join("");
  return new RegExp(`\\b${first}${body}\\b`);
}

/** Built once — these are regexes over a fixed list, not per-request work. */
const CENSORED_PATTERNS: Array<{ term: string; re: RegExp }> = BLOCKED_TERMS.map(
  (term) => ({ term, re: censoredPattern(term.replace(/(.)\1+/g, "$1")) }),
);

/**
 * The blocked term found in `body`, or null if it is clean.
 *
 * Returns the term rather than a boolean so the caller can log what tripped
 * without echoing the user's whole comment into the logs.
 */
export function findBlockedTerm(body: string): string | null {
  const haystack = ` ${normalise(body)} `;
  for (const term of BLOCKED_TERMS) {
    // Fold the term the same way the body was folded, or a term with a double
    // letter would never match ("bollocks" normalises to "bolocks").
    const needle = term.replace(/(.)\1+/g, "$1");
    if (haystack.includes(` ${needle} `)) return term;
  }

  // Second pass for censored spellings. Run against the folded text with
  // punctuation still in place, since the punctuation is the thing being
  // matched — normalise() would already have stripped it out.
  const censored = fold(body);
  for (const { term, re } of CENSORED_PATTERNS) {
    if (re.test(censored)) return term;
  }
  return null;
}
