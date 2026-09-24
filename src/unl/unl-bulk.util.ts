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
 *  - **A paste block for the fixtures.** One line per match: group, the two
 *    nations, the kickoff, and the matchday.
 *
 * Both are pure functions with no database access, so the parsing can be
 * tested without one. Resolving a pasted nation name to an actual team is the
 * service's job, and it matches exactly — never by substring, because this
 * competition fields Republic of Ireland and Northern Ireland.
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

// ── Parsing a pasted fixture list ───────────────────────────────────────────

export interface ParsedFixture {
  groupKey: string;
  homeName: string;
  awayName: string;
  /** Absolute instant, resolved from the admin's own timezone. */
  kickoffAt: string;
  matchday: number | null;
}

export interface ParseFixturesResult {
  fixtures: ParsedFixture[];
  errors: string[];
}

/**
 * `YYYY-MM-DD HH:MM`, read in the admin's timezone unless it carries its own.
 *
 * Deliberately narrow. Accepting `04/09/2026` would mean guessing between the
 * 4th of September and the 9th of April, and the wrong guess is a market that
 * closes months from the match. An explicit `Z` or `+06:00` wins; otherwise
 * `tzOffsetMinutes` (the browser's own `getTimezoneOffset()`) is applied, so a
 * pasted time means the same thing as one typed into the date picker.
 */
function parseKickoff(
  raw: string,
  tzOffsetMinutes: number,
): { iso: string } | { error: string } {
  const text = raw.trim();
  const m = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})\s*(Z|[+-]\d{2}:?\d{2})?$/i,
  );
  if (!m) {
    return {
      error: `"${text}" is not a date I can read. Use YYYY-MM-DD HH:MM, e.g. 2026-09-04 20:45.`,
    };
  }
  const [, y, mo, d, hh, mm, zone] = m;
  const base = Date.UTC(+y, +mo - 1, +d, +hh, +mm);

  // Date.UTC rolls 2026-02-31 forward into March rather than rejecting it, so
  // check the calendar date here — before any offset shifts it legitimately.
  const asGiven = new Date(base);
  if (
    asGiven.getUTCFullYear() !== +y ||
    asGiven.getUTCMonth() !== +mo - 1 ||
    asGiven.getUTCDate() !== +d ||
    +hh > 23 ||
    +mm > 59
  ) {
    return { error: `"${text}" is not a real date and time.` };
  }

  let ms: number;
  if (!zone) {
    // No zone given: the numbers are wall-clock time where the admin is.
    ms = base + tzOffsetMinutes * 60_000;
  } else if (zone.toUpperCase() === "Z") {
    ms = base;
  } else {
    const zm = zone.replace(":", "");
    const sign = zm[0] === "-" ? -1 : 1;
    const offMin = sign * (+zm.slice(1, 3) * 60 + +zm.slice(3, 5));
    ms = base - offMin * 60_000;
  }

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return { error: `"${text}" is not a real date and time.` };
  }
  return { iso: date.toISOString() };
}

/**
 * Parse a pasted fixture list.
 *
 * One line per match, pipe-separated, because a nation name can contain a
 * comma far more plausibly than a pipe:
 *
 *     A | France | Italy | 2026-09-04 20:45 | 1
 *     A | France vs Italy | 2026-09-04 20:45 | 1
 *     A | France | Italy | 2026-09-04 20:45
 *
 * The matchday is optional. Team names are resolved against the group later,
 * by exact (accent-folded) match — never by substring, because this
 * competition fields Republic of Ireland and Northern Ireland.
 */
export function parseFixtureBlock(
  text: string,
  tzOffsetMinutes = 0,
): ParseFixturesResult {
  const fixtures: ParsedFixture[] = [];
  const errors: string[] = [];

  (text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const lineNo = i + 1;

    let parts = line.split("|").map((s) => s.trim()).filter((s, idx) => s !== "" || idx > 0);

    // "France vs Italy" in one field counts as two.
    if (parts.length >= 3 && parts.length <= 4) {
      const vs = parts[1]?.match(/^(.+?)\s+(?:vs?\.?|v)\s+(.+)$/i);
      if (vs) parts = [parts[0], vs[1].trim(), vs[2].trim(), ...parts.slice(2)];
    }

    if (parts.length < 4) {
      errors.push(
        `Line ${lineNo}: expected group | home | away | kickoff [| matchday].`,
      );
      return;
    }

    const groupRaw = parts[0].replace(/^group\s*/i, "").trim();
    if (!/^[A-Za-z]$/.test(groupRaw)) {
      errors.push(`Line ${lineNo}: "${parts[0]}" is not a group letter.`);
      return;
    }

    const homeName = parts[1];
    const awayName = parts[2];
    if (!homeName || !awayName) {
      errors.push(`Line ${lineNo}: both nations are required.`);
      return;
    }
    if (homeName.toLowerCase() === awayName.toLowerCase()) {
      errors.push(`Line ${lineNo}: ${homeName} cannot play itself.`);
      return;
    }

    const kickoff = parseKickoff(parts[3], tzOffsetMinutes);
    if ("error" in kickoff) {
      errors.push(`Line ${lineNo}: ${kickoff.error}`);
      return;
    }

    let matchday: number | null = null;
    if (parts[4] != null && parts[4] !== "") {
      const n = Number(parts[4]);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        errors.push(`Line ${lineNo}: "${parts[4]}" is not a matchday number.`);
        return;
      }
      matchday = n;
    }

    fixtures.push({
      groupKey: groupRaw.toUpperCase(),
      homeName,
      awayName,
      kickoffAt: kickoff.iso,
      matchday,
    });
  });

  return { fixtures, errors };
}

/** Exported so the service can resolve pasted names the same way. */
export function nationKey(name: string): string {
  return flagKey(name);
}
