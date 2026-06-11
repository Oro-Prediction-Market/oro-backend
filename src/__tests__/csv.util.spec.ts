import { csvCell } from "../shared/utils/csv.util";

describe("csvCell — CSV escaping & formula-injection neutralization", () => {
  it("returns empty string for null/undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell("Alice Smith")).toBe("Alice Smith");
  });

  it("quotes values containing commas, quotes, or newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralizes formula triggers by prefixing a single quote", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(
      `"'=HYPERLINK(""http://evil"",""x"")"`,
    );
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
  });

  it("does NOT prefix legitimate numbers (negative amounts stay numeric)", () => {
    expect(csvCell(-100)).toBe("-100");
    expect(csvCell("-100")).toBe("-100");
    expect(csvCell("-100.50")).toBe("-100.50");
    expect(csvCell("+5")).toBe("+5");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(1234.56)).toBe("1234.56");
  });

  it("neutralizes a formula that merely starts like a number", () => {
    // Starts with '-' but is not a plain number — must be neutralized.
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("-1+cmd")).toBe("'-1+cmd");
  });

  it("handles a formula trigger that also needs CSV quoting", () => {
    expect(csvCell("=1+1,2")).toBe(`"'=1+1,2"`);
  });
});
