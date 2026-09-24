/**
 * Bulk entry for the Nations League.
 *
 * Entering this competition by hand is 54 nations and, at six matchdays per
 * group, over 150 fixtures. Typed one at a time that is not just slow, it is
 * where the typos come from — and a typo here is a wrong outcome label on a
 * market or a fixture in the wrong group.
 *
 * Two things reduce almost all of that typing:
 *
 *  - **A paste block for the draw.** One line per group, which is how the draw
 *    is published and how anyone would write it down anyway.
 *  - **A generated round-robin.** A group's fixture list is not information —
 *    it is determined by who is in the group. Four teams playing home and away
 *    is always the same twelve pairings over six matchdays, so there is
 *    nothing to type.
 *
 * Both are pure functions with no database access, so the parsing and the
 * scheduling can be tested without one.
 */

// ── Flags ───────────────────────────────────────────────────────────────────

/**
 * Nation → flagcdn code, for every UEFA member.
 *
 * So an admin pastes names and gets flags, rather than hunting 54 URLs. The
 * four UK nations have their own codes (`gb-eng` and friends) and Kosovo is
 * `xk`, neither of which is guessable.
 *
 * Lookup is by normalised name, so "Turkiye" finds "Türkiye" and "Czech
 * Republic" finds "Czechia" via the aliases below. A name that is not here
 * simply gets no flag — never a wrong one.
 */
const FLAG_CODES: Record<string, string> = {
  albania: "al",
  andorra: "ad",
  armenia: "am",
  austria: "at",
  azerbaijan: "az",
  belarus: "by",
  belgium: "be",
  "bosnia and herzegovina": "ba",
  bulgaria: "bg",
  croatia: "hr",
  cyprus: "cy",
  czechia: "cz",
  denmark: "dk",
  england: "gb-eng",
  estonia: "ee",
  "faroe islands": "fo",
  finland: "fi",
  france: "fr",
  georgia: "ge",
  germany: "de",
  gibraltar: "gi",
  greece: "gr",
  hungary: "hu",
  iceland: "is",
  israel: "il",
  italy: "it",
  kazakhstan: "kz",
  kosovo: "xk",
  latvia: "lv",
  liechtenstein: "li",
  lithuania: "lt",
  luxembourg: "lu",
  malta: "mt",
  moldova: "md",
  montenegro: "me",
  netherlands: "nl",
  "north macedonia": "mk",
  "northern ireland": "gb-nir",
  norway: "no",
  poland: "pl",
  portugal: "pt",
  "republic of ireland": "ie",
  romania: "ro",
  russia: "ru",
  "san marino": "sm",
  scotland: "gb-sct",
  serbia: "rs",
  slovakia: "sk",
  slovenia: "si",
  spain: "es",
  sweden: "se",
  switzerland: "ch",
  turkiye: "tr",
  ukraine: "ua",
  wales: "gb-wls",
};

/** Spellings that are the same nation. The canonical name is what gets stored. */
const ALIASES: Record<string, string> = {
  "czech republic": "czechia",
  turkey: "turkiye",
  holland: "netherlands",
  ireland: "republic of ireland",
  eire: "republic of ireland",
  macedonia: "north macedonia",
  "bosnia herzegovina": "bosnia and herzegovina",
  bosnia: "bosnia and herzegovina",
  "faroes": "faroe islands",
};

/** Accent- and punctuation-insensitive, so "Türkiye" and "Turkiye" agree. */
function flagKey(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A flag URL for a known nation, or null. Never a guess. */
export function flagUrlFor(name: string): string | null {
  const key = flagKey(name);
  const code = FLAG_CODES[ALIASES[key] ?? key];
  return code ? `https://flagcdn.com/w320/${code}.png` : null;
}

// ── Parsing a pasted draw ───────────────────────────────────────────────────

export interface ParsedTeam {
  groupKey: string;
  name: string;
  flagUrl: string | null;
  /** True when the name is not a UEFA member we recognise — worth a second look. */
  unknownNation: boolean;
}

export interface ParseTeamsResult {
  teams: ParsedTeam[];
  /** Human-readable problems, one per offending line. */
  errors: string[];
}

/**
 * Parse a pasted draw into teams.
 *
 * Accepted, because these are all how someone would actually write it:
 *
 *     A: France, Italy, Belgium, Türkiye
 *     Group B - Spain, Netherlands, Denmark, Czechia
 *     C | Portugal | Croatia | Poland | Scotland
 *
 * Blank lines are skipped. A line without a group prefix is an error rather
 * than a guess — silently attaching four nations to the previous group is the
 * kind of "helpful" behaviour that puts a team in the wrong table.
 */
export function parseTeamBlock(text: string): ParseTeamsResult {
  const teams: ParsedTeam[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const lines = (text ?? "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const lineNo = i + 1;

    // "A:", "Group A:", "A -", "A |" … then the nations.
    const m = line.match(/^(?:group\s*)?([A-Za-z])\s*[:\-|]\s*(.+)$/i);
    if (!m) {
      errors.push(
        `Line ${lineNo}: no group letter. Write it like "A: France, Italy, Belgium, Türkiye".`,
      );
      return;
    }

    const groupKey = m[1].toUpperCase();
    const names = m[2]
      .split(/[,|;]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (names.length === 0) {
      errors.push(`Line ${lineNo}: group ${groupKey} has no nations after it.`);
      return;
    }

    for (const name of names) {
      const dedupe = `${groupKey}|${flagKey(name)}`;
      if (seen.has(dedupe)) {
        errors.push(`Line ${lineNo}: ${name} is listed twice in group ${groupKey}.`);
        continue;
      }
      seen.add(dedupe);
      const flagUrl = flagUrlFor(name);
      teams.push({ groupKey, name, flagUrl, unknownNation: flagUrl === null });
    }
  });

  return { teams, errors };
}

// ── Generating a group's fixtures ───────────────────────────────────────────

export interface GeneratedPairing {
  matchday: number;
  homeIndex: number;
  awayIndex: number;
}

/**
 * The round-robin for `count` teams, by the circle method.
 *
 * With an odd number of teams one sits out each round, which is exactly what
 * happens in a three-team group — League D has them, so this is not a
 * hypothetical.
 *
 * `rounds: 2` plays the whole thing again with home and away swapped, which is
 * the Nations League format: four teams, six matchdays, twelve matches.
 *
 * Returns indices rather than ids so it can be tested without any teams.
 */
export function roundRobin(count: number, rounds: 1 | 2): GeneratedPairing[] {
  if (count < 2) return [];

  // Odd counts get a bye marker, which drops back out below.
  const BYE = -1;
  const ids = Array.from({ length: count }, (_, i) => i);
  if (ids.length % 2 === 1) ids.push(BYE);

  const n = ids.length;
  const halfRounds = n - 1;
  const out: GeneratedPairing[] = [];

  for (let leg = 0; leg < rounds; leg++) {
    // Rotate all but the first entry; standard circle method.
    const wheel = [...ids];
    for (let r = 0; r < halfRounds; r++) {
      const matchday = leg * halfRounds + r + 1;
      for (let i = 0; i < n / 2; i++) {
        const a = wheel[i];
        const b = wheel[n - 1 - i];
        if (a === BYE || b === BYE) continue;
        // Alternate which side is home across the wheel so one team does not
        // take every home fixture, then swap wholesale for the second leg.
        const homeFirst = i % 2 === 0 ? leg === 0 : leg !== 0;
        out.push({
          matchday,
          homeIndex: homeFirst ? a : b,
          awayIndex: homeFirst ? b : a,
        });
      }
      // Rotate: keep index 0 fixed, move the last into position 1.
      wheel.splice(1, 0, wheel.pop()!);
    }
  }

  return out;
}

/** How many matchdays `count` teams need over `rounds` legs. */
export function matchdayCount(count: number, rounds: 1 | 2): number {
  if (count < 2) return 0;
  const n = count % 2 === 1 ? count + 1 : count;
  return (n - 1) * rounds;
}
