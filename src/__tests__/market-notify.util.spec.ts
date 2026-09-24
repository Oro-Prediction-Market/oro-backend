import { isCompetitionSubcategory } from "../markets/market-notify.util";

/**
 * This predicate is the only thing standing between a football matchday and the
 * Telegram channel. It was missed once already — the Nations League shipped
 * without its prefix here, which would have posted a settlement announcement
 * for all 27 group-stage matches — so the competitions are asserted by name
 * rather than by a loop, and a new one has to be added here deliberately.
 */
describe("isCompetitionSubcategory", () => {
  it("covers every competition whose markets settle per fixture", () => {
    expect(isCompetitionSubcategory("epl-match")).toBe(true);
    expect(isCompetitionSubcategory("ucl-match")).toBe(true);
    expect(isCompetitionSubcategory("unl-match")).toBe(true);
  });

  it("covers the season stat boards, not just the fixtures", () => {
    // These settle once, but they settle in a burst at season end.
    expect(isCompetitionSubcategory("epl-topscorer")).toBe(true);
    expect(isCompetitionSubcategory("ucl-assists")).toBe(true);
    expect(isCompetitionSubcategory("unl-topscorer")).toBe(true);
    expect(isCompetitionSubcategory("unl-assists")).toBe(true);
  });

  it("still announces admin-created and one-off markets", () => {
    // Silencing these would remove the channel's only settlement signal.
    expect(isCompetitionSubcategory("politics")).toBe(false);
    expect(isCompetitionSubcategory("wc-final")).toBe(false);
    expect(isCompetitionSubcategory("ter")).toBe(false);
    expect(isCompetitionSubcategory(null)).toBe(false);
    expect(isCompetitionSubcategory(undefined)).toBe(false);
    expect(isCompetitionSubcategory("")).toBe(false);
  });

  it("matches on the prefix only, so a lookalike still announces", () => {
    expect(isCompetitionSubcategory("UNL-MATCH")).toBe(true);
    expect(isCompetitionSubcategory("unlikely-event")).toBe(false);
    expect(isCompetitionSubcategory("my-epl-tribute")).toBe(false);
  });
});
