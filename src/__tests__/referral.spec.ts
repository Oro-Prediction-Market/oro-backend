/**
 * Tests for referral bonus logic inside ParimutuelEngine.
 * Formula: Nu 25 flat + 5% of first bet, capped at Nu 75.
 */
import { ParimutuelEngine } from "../markets/parimutuel.engine";

describe("ParimutuelEngine referral bonus constants", () => {
  it("flat bonus is Nu 25", () => {
    expect(ParimutuelEngine.REFERRAL_FLAT_BONUS).toBe(25);
  });

  it("bet pct is 5%", () => {
    expect(ParimutuelEngine.REFERRAL_BET_PCT).toBeCloseTo(0.05);
  });

  it("cap is Nu 75", () => {
    expect(ParimutuelEngine.REFERRAL_CAP).toBe(75);
  });

  it("small bet Nu 20: flat(25) + 5%(20)=1 → 26", () => {
    const pct = Math.round(20 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(26);
  });

  it("medium bet Nu 100: flat(25) + 5%(100)=5 → 30", () => {
    const pct = Math.round(100 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(30);
  });

  it("large bet Nu 500: flat(25) + 5%(500)=25 → 50", () => {
    const pct = Math.round(500 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(50);
  });

  it("very large bet Nu 1000: flat(25) + 5%(1000)=50 → 75 (capped)", () => {
    const pct = Math.round(1000 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(75);
  });

  it("huge bet Nu 5000: still capped at 75", () => {
    const pct = Math.round(5000 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(75);
  });
});
