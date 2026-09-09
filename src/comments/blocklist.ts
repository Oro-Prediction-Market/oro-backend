/**
 * A word blocklist for comment bodies.
 *
 * WHAT THIS IS AND IS NOT. This catches profanity typed straight into the box,
 * including the obvious evasions (spacing, repeated letters, leetspeak,
 * censor characters) and the ordinary English inflections of a listed term.
 * That is all it does.
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
 * Terms are matched as WHOLE WORDS — never as substrings. Substring matching is
 * the classic way these lists go wrong: on a prediction market "analysis" and
 * "analyst" are everyday words (Analyst is one of our own reputation tiers),
 * and a prefix match on a shorter term would reject them.
 *
 * List the BASE form only. Matching adds, for free:
 *   - the inflections in SUFFIXES ("bitch" covers bitches, bitching, bitchy),
 *   - a stretched or doubled letter ("fuuuck", "shitting", "cumming"),
 *   - leetspeak and accents ("sh1t", "bïtch"),
 *   - spacing and punctuation padding ("f.u.c.k", "s h i t"),
 *   - censored spellings for terms of 4+ letters ("f*ck", "c-nt", "sh#t").
 * A form that is not reachable that way — "fuk", "wtf", "shitty" — needs its own
 * entry. Note the absent "-y": it would have cost "cocky", "booby" and "hooey",
 * which is why the two -y forms that matter are listed outright instead.
 *
 * Terms must be lowercase a-z, optionally with single spaces for a phrase.
 * Nothing here is regex-escaped, so punctuation in a term would misbehave.
 *
 * DELIBERATELY ABSENT. Mild words carry real meaning in match argument and are
 * left to the flag queue: damn, hell, crap, piss, bugger, idiot, stupid, moron,
 * dumb, scum, sucks. So is "git" (it is a tool people here name daily). So are
 * "queer" and "dyke": both have ordinary and reclaimed uses, so blocking them
 * would misfire on the people they are used against — a slur that depends on
 * context is a job for a human moderator, not a string match.
 */
const BLOCKED_TERMS: string[] = [
  // ── General profanity and insults ──────────────────────────────────────────
  "arse",
  "arsehole",
  "ass",
  "asshat",
  "asshole",
  "asswipe",
  "bastard",
  "bellend",
  "bitch",
  "bitchy",
  "bollock",
  "bullshit",
  "clusterfuck",
  "cock",
  "cocksucker",
  "cunt",
  "dick",
  "dickface",
  "dickhead",
  "douche",
  "douchebag",
  "dumbass",
  "fuck",
  "fuckface",
  "fuckwit",
  "jackass",
  "knobhead",
  "motherfuck",
  "prick",
  "shit",
  "shithead",
  "shithole",
  "shitty",
  "tosser",
  "twat",
  "wank",
  // Spellings the inflection rules cannot reach from a base above.
  "fck",
  "fuk",
  "stfu",
  "wtf",

  // ── Sexual ─────────────────────────────────────────────────────────────────
  // "hoe" and "tit" have innocent senses (a garden tool, a bird). Neither is
  // plausible in a market thread, and both are common enough as abuse to be
  // worth the theoretical false positive.
  "anal",
  "anus",
  "blowjob",
  "boob",
  "butthole",
  "cum",
  "handjob",
  "hoe",
  "jizz",
  "milf",
  "nipple",
  "penis",
  "porn",
  "porno",
  "pussy",
  "slut",
  "thot",
  "tit",
  "titty",
  "vagina",
  "whore",

  // ── Slurs ──────────────────────────────────────────────────────────────────
  "chink",
  "coon",
  "faggot",
  "fag",
  "gook",
  "kike",
  "mongoloid",
  "nigga",
  "nigger",
  "paki",
  "retard",
  "spastic",
  "spaz",
  "spic",
  "tranny",
  "wetback",

  // ── Harassment and sexual violence ─────────────────────────────────────────
  "bestiality",
  "incest",
  "kys",
  "kill yourself",
  "kill urself",
  "molest",
  "paedo",
  "paedophile",
  "pedo",
  "pedophile",
  "rape",
  "rapist",

  // ── Romanised Hindi/Nepali ─────────────────────────────────────────────────
  // Widely used in the region and, unlike romanised Dzongkha, spelled stably
  // enough to match. This is the section most worth a moderator's review — the
  // two-letter abbreviations (mc, bc) are deliberately omitted as far too
  // collision-prone.
  "behenchod",
  "bhenchod",
  "bhosdike",
  "chutia",
  "chutiya",
  "gandu",
  "harami",
  "kamina",
  "lauda",
  "madarchod",
  "randi",
];

/**
 * English inflections a base term covers. Deliberately short: every entry here
 * widens every term at once, so anything ambiguous ("a", "an", "al") would put
 * ordinary words at risk across the whole list.
 */
const SUFFIXES = ["s", "es", "d", "ed", "ing", "in", "er", "ers", "ies"];
const SUFFIX_GROUP = `(?:${SUFFIXES.join("|")})?`;

/**
 * Common character substitutions used to slip a term past a plain string match.
 * Applied after lowercasing.
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

/** Lowercase and drop accents, changing nothing else. */
function flatten(input: string): string {
  return (
    input
      .toLowerCase()
      // Decompose accents (é -> e + combining acute) and drop the marks.
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
  );
}

/** Lowercase, accent-stripped, and leetspeak mapped back to letters. */
function fold(input: string): string {
  return Array.from(flatten(input))
    .map((ch) => LEET_MAP[ch] ?? ch)
    .join("");
}

/**
 * Fold a body down to the form the plain pass matches against: every non-letter
 * becomes a single space, so punctuation and zero-width padding cannot break a
 * term apart.
 *
 * Exported for the tests, which assert on the folding rather than only the
 * verdict.
 */
export function normalise(input: string): string {
  return (
    fold(input)
      .replace(/[^a-z]+/g, " ")
      // A term split by separators ("f u c k") closes back up only when every
      // fragment is a single letter; joining unconditionally would merge
      // ordinary adjacent words into false positives.
      .replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (run) => run.replace(/ /g, ""))
      .trim()
  );
}

/**
 * Every letter is matched as `x+` rather than `x`, which absorbs two evasions
 * and one grammar rule in a single stroke: a stretched letter ("fuuuck"), a
 * doubled one, and English consonant doubling before a suffix ("shitting",
 * "cumming") all fall out of it.
 *
 * This replaced an earlier approach that collapsed repeated letters in the body
 * instead. That could not survive a three-letter term: collapsing turns "ass"
 * into "as", and " as " appears in most English sentences.
 */
function plainPattern(term: string): RegExp {
  const body = term
    .split(" ")
    .map((word) =>
      Array.from(word)
        .map((ch) => `${ch}+`)
        .join(""),
    )
    .join("\\s+");
  return new RegExp(`\\b${body}${SUFFIX_GROUP}\\b`);
}

/**
 * Characters people use to blank out a letter: f*ck, sh#t, c-nt. Digits and
 * leetspeak symbols are in here too, so the censored pass also covers a
 * substitution the leet map cannot undo ("c4nt" is folded to "cant", which is a
 * word, but 4 reads as a blanked-out letter here).
 */
const CENSOR_CLASS = "*#%&?.\\-_~^=0-9@$!|+";

/**
 * A term with any letter after the first blanked out by a censor character.
 *
 * The first letter of each word stays literal. Without that anchor a term of N
 * letters would be matched by N censor characters — someone politely typing
 * "****" would be rejected — and evasions keep the first letter anyway, because
 * the point is to stay readable.
 *
 * Only terms of 4+ letters get this pass. At three letters the pattern is one
 * literal plus two wildcards, which is loose enough to hit ordinary strings
 * like initials or a scoreline.
 */
function censoredPattern(term: string): RegExp {
  const body = term
    .split(" ")
    .map((word) => {
      const [first, ...rest] = Array.from(word);
      return (
        `${first}+` +
        rest.map((ch) => `(?:${ch}+|[${CENSOR_CLASS}])`).join("")
      );
    })
    .join("\\s+");
  return new RegExp(`\\b${body}${SUFFIX_GROUP}\\b`);
}

/** Built once — these are regexes over a fixed list, not per-request work. */
const PLAIN_PATTERNS = BLOCKED_TERMS.map((term) => ({
  term,
  re: plainPattern(term),
}));

const CENSORED_PATTERNS = BLOCKED_TERMS.filter(
  (term) => term.replace(/ /g, "").length >= 4,
).map((term) => ({ term, re: censoredPattern(term) }));

/**
 * The blocked term found in `body`, or null if it is clean.
 *
 * Returns the term rather than a boolean so the caller can log what tripped
 * without echoing the user's whole comment into the logs.
 */
export function findBlockedTerm(body: string): string | null {
  const plain = normalise(body);
  for (const { term, re } of PLAIN_PATTERNS) {
    if (re.test(plain)) return term;
  }

  // Second pass for censored spellings, against text that still has its
  // punctuation and digits — those are the thing being matched here, and
  // normalise() would already have stripped them out. The leet map is skipped
  // too, so a substituted character is still visible as a blank.
  const censored = flatten(body);
  for (const { term, re } of CENSORED_PATTERNS) {
    if (re.test(censored)) return term;
  }
  return null;
}
