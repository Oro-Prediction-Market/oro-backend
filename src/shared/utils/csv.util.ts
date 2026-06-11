/**
 * Escape a single value for safe inclusion in a CSV cell.
 *
 * Handles two distinct concerns:
 *
 * 1. CSV structure — wrap the value in double quotes (doubling any internal
 *    quote) when it contains a delimiter, quote, or newline, so the row keeps
 *    its column boundaries.
 *
 * 2. CSV / formula injection (CWE-1236) — spreadsheet programs (Excel, Google
 *    Sheets, LibreOffice) treat a cell that begins with `=`, `+`, `-`, `@`, or
 *    a leading TAB/CR as a *formula* and execute it on open. Since some cells
 *    derive from user-controlled input (usernames, notes, descriptions), an
 *    attacker could store e.g. `=HYPERLINK(...)` or `=cmd|'/c ...'!A1` and have
 *    it run on the machine of whoever opens the export. We neutralize this by
 *    prefixing such values with a single quote, which forces the spreadsheet to
 *    render them as literal text.
 *
 *    Genuine numbers (including negative amounts like `-100` and signed values
 *    like `+5`) are intentionally NOT prefixed — they start with `-`/`+` but are
 *    not formulas, and prefixing them would corrupt numeric columns.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str = String(value);

  // Neutralize formula triggers, but leave plain numeric values untouched so
  // numeric columns (amounts, balances) stay numeric.
  const startsWithTrigger = /^[=+\-@\t\r]/.test(str);
  const isPlainNumber = /^[+-]?\d+(\.\d+)?$/.test(str);
  if (startsWithTrigger && !isPlainNumber) {
    str = `'${str}`;
  }

  // Quote when the value would otherwise break CSV structure.
  if (/[",\n\r]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}
