import {
  CURRENCY_DECIMALS,
  floorMoney,
  moneyDecimals,
  roundMoney,
} from "../shared/utils/money.util";

describe("currency precision", () => {
  it("knows both launch currencies", () => {
    expect(moneyDecimals("BTN")).toBe(2);
    expect(moneyDecimals("USDT")).toBe(6);
    expect(Object.keys(CURRENCY_DECIMALS).sort()).toEqual(["BTN", "USDT"]);
  });

  it("throws on an unknown currency rather than guessing", () => {
    // A default would round a new currency to somebody else's precision and
    // say nothing — the same silent-wrong-answer class the ledger guard exists
    // to prevent.
    expect(() => moneyDecimals("EUR")).toThrow(/EUR/);
    expect(() => moneyDecimals("")).toThrow();
    expect(() => roundMoney(1.5, "TON")).toThrow(/TON/);
  });
});

describe("roundMoney", () => {
  it("is bit-for-bit what the settlement path did before, for BTN", () => {
    // The whole point: no existing ngultrum payout may move by a chhertum.
    const samples = [
      0, 1, 0.005, 0.014999, 1.005, 2.675, 33.333333, 66.666666, 99.994999,
      100.005, 276, 413.9999, 1234.567, 0.1 + 0.2, 1e-9, 987654.321,
    ];
    for (const v of samples) {
      expect({ v, got: roundMoney(v, "BTN") }).toEqual({
        v,
        got: parseFloat(v.toFixed(2)),
      });
    }
  });

  it("keeps six decimal places for USDT", () => {
    expect(roundMoney(1.2345678, "USDT")).toBe(1.234568);
    expect(roundMoney(0.000001, "USDT")).toBe(0.000001);
    expect(roundMoney(57.123456, "USDT")).toBe(57.123456);
  });

  it("stops USDT dust from being rounded away", () => {
    // This is the bug the change exists to fix: at 2dp these all collapse to
    // zero, and a user's money quietly disappears.
    const dust = [0.000001, 0.0001, 0.004999];
    for (const v of dust) {
      expect(roundMoney(v, "BTN")).toBe(v < 0.005 ? 0 : 0.01);
      expect(roundMoney(v, "USDT")).toBe(v);
    }
  });

  it("handles negatives symmetrically", () => {
    expect(roundMoney(-1.005, "BTN")).toBe(parseFloat((-1.005).toFixed(2)));
    expect(roundMoney(-0.0000004, "USDT")).toBe(-0);
  });
});

describe("floorMoney", () => {
  it("never rounds up", () => {
    expect(floorMoney(1.999, "BTN")).toBe(1.99);
    expect(floorMoney(1.9999999, "USDT")).toBe(1.999999);
    expect(floorMoney(0.0000009, "USDT")).toBe(0);
  });

  it("leaves exact values alone", () => {
    expect(floorMoney(1.99, "BTN")).toBe(1.99);
    expect(floorMoney(0.000001, "USDT")).toBe(0.000001);
  });
});
