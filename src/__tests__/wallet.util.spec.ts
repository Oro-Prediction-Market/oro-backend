import {
  allowedCurrencies,
  resolveWalletCurrency,
  usdtIdentityVerified,
} from "../shared/utils/wallet.util";
import { KycStatus } from "../entities/user.entity";

const btn = (over: any = {}) =>
  ({
    currency: "BTN",
    kycStatus: KycStatus.NONE,
    dkAccountNumber: null,
    ...over,
  }) as any;

describe("usdtIdentityVerified", () => {
  it("accepts an approved document", () => {
    expect(usdtIdentityVerified(btn({ kycStatus: KycStatus.APPROVED }))).toBe(
      true,
    );
  });

  it("accepts a linked DK Bank account without a document", () => {
    // A verified CID is national identity checked by a bank — stronger than a
    // photographed passport read by a reviewer.
    expect(usdtIdentityVerified(btn({ dkAccountNumber: "200123456" }))).toBe(
      true,
    );
  });

  it("refuses an account that has proved nothing", () => {
    expect(usdtIdentityVerified(btn())).toBe(false);
  });

  it("does not treat a USDT-native account as verified", () => {
    // The regression this guards: an earlier version short-circuited on
    // currency === "USDT" and removed the deposit gate for every international
    // user — precisely the accounts it exists to gate.
    expect(
      usdtIdentityVerified({
        currency: "USDT",
        kycStatus: KycStatus.NONE,
        dkAccountNumber: null,
      } as any),
    ).toBe(false);
  });

  it("refuses a pending or rejected document", () => {
    for (const kycStatus of [KycStatus.PENDING, KycStatus.REJECTED]) {
      expect(usdtIdentityVerified(btn({ kycStatus }))).toBe(false);
    }
  });
});

describe("allowedCurrencies", () => {
  it("gives a verified Bhutanese account both wallets", () => {
    expect(allowedCurrencies(btn({ dkAccountNumber: "200123456" }))).toEqual([
      "BTN",
      "USDT",
    ]);
  });

  it("gives an unverified Bhutanese account ngultrum only", () => {
    expect(allowedCurrencies(btn())).toEqual(["BTN"]);
  });

  it("never gives a USDT-native account ngultrum", () => {
    // BTN only enters through DK Bank, which needs a Bhutanese identity, so a
    // BTN wallet on such an account could be credited but never funded.
    expect(
      allowedCurrencies({
        currency: "USDT",
        kycStatus: KycStatus.APPROVED,
        dkAccountNumber: null,
      } as any),
    ).toEqual(["USDT"]);
  });

  it("defaults a missing currency to ngultrum", () => {
    // Older rows predate the column.
    expect(allowedCurrencies({ currency: null } as any)).toEqual(["BTN"]);
  });
});

describe("resolveWalletCurrency", () => {
  it("falls back to the native currency when none is asked for", () => {
    // Every existing caller passes nothing and must keep its behaviour.
    expect(resolveWalletCurrency(btn())).toEqual({
      currency: "BTN",
      allowed: true,
    });
  });

  it("allows a currency the account may hold", () => {
    expect(
      resolveWalletCurrency(btn({ kycStatus: KycStatus.APPROVED }), "USDT"),
    ).toEqual({ currency: "USDT", allowed: true });
  });

  it("refuses a currency the account may not hold", () => {
    expect(resolveWalletCurrency(btn(), "USDT")).toEqual({
      currency: "USDT",
      allowed: false,
    });
  });

  it("normalises case rather than silently refusing", () => {
    expect(
      resolveWalletCurrency(btn({ kycStatus: KycStatus.APPROVED }), "usdt"),
    ).toEqual({ currency: "USDT", allowed: true });
  });

  it("refuses a currency that does not exist", () => {
    expect(
      resolveWalletCurrency(btn({ kycStatus: KycStatus.APPROVED }), "EUR"),
    ).toEqual({ currency: "EUR", allowed: false });
  });
});
