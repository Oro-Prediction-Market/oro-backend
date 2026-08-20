import {
  fromBaseUnits,
  isValidAddressForNetwork,
  isValidEvmAddress,
  isValidTronAddress,
  toBaseUnits,
} from "../payment/usdt.util";
import {
  CryptoNetwork,
  parseEnabledNetworks,
} from "../payment/services/twentyone-pay/twentyone-pay.types";
import { TwentyOnePayClient } from "../payment/services/twentyone-pay/twentyone-pay.client";
import * as crypto from "node:crypto";

describe("USDT base-unit conversion", () => {
  it("converts whole and fractional amounts", () => {
    expect(toBaseUnits("1")).toBe("1000000");
    expect(toBaseUnits("1.00")).toBe("1000000");
    expect(toBaseUnits("1.5")).toBe("1500000");
    expect(toBaseUnits("0.000001")).toBe("1");
    expect(toBaseUnits("0")).toBe("0");
  });

  it("does not lose precision on values that break float math", () => {
    // 1.1 * 1e6 === 1100000.0000000002 in IEEE-754.
    expect(toBaseUnits("1.1")).toBe("1100000");
    expect(toBaseUnits("0.07")).toBe("70000");
    expect(toBaseUnits("999999.999999")).toBe("999999999999");
  });

  it("tolerates the trailing zeros Postgres adds, but not real over-precision", () => {
    // Money columns are numeric(28,9), so a value written as 25.5 comes back
    // as "25.500000000". Those zeros are not precision, and rejecting them
    // would mean a round trip through the database invalidates a valid amount
    // — which is exactly what happened the first time this ran for real.
    expect(toBaseUnits("25.500000000")).toBe("25500000");
    expect(toBaseUnits("10.000000000")).toBe("10000000");
    expect(toBaseUnits("0.000001000")).toBe("1");
    // Significant digits beyond 6dp are still a rejection.
    expect(() => toBaseUnits("1.0000001")).toThrow();
    expect(() => toBaseUnits("1.00000010")).toThrow();
  });

  it("rejects malformed or over-precise amounts", () => {
    expect(() => toBaseUnits("1.0000001")).toThrow(); // 7 dp
    expect(() => toBaseUnits("-1")).toThrow();
    expect(() => toBaseUnits("abc")).toThrow();
    expect(() => toBaseUnits("")).toThrow();
    expect(() => toBaseUnits("1e6")).toThrow();
  });

  it("round-trips exactly", () => {
    for (const v of ["0", "1", "1.5", "0.000001", "12345.678901"]) {
      expect(fromBaseUnits(toBaseUnits(v))).toBe(
        v === "1.00" ? "1" : String(Number(v)),
      );
    }
  });

  it("formats base units back to human strings without trailing zeros", () => {
    expect(fromBaseUnits("1000000")).toBe("1");
    expect(fromBaseUnits("1500000")).toBe("1.5");
    expect(fromBaseUnits("1")).toBe("0.000001");
    expect(fromBaseUnits("0")).toBe("0");
  });
});

describe("TRON address validation", () => {
  it("accepts well-known valid mainnet addresses", () => {
    // Official USDT TRC-20 contract address.
    expect(isValidTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(true);
  });

  it("rejects a single-character typo (checksum catches it)", () => {
    // Last char changed — passes a naive ^T[A-Za-z0-9]{33}$ regex, fails checksum.
    expect(isValidTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBe(false);
  });

  it("rejects wrong-network and malformed addresses", () => {
    expect(isValidTronAddress("0x0000000000000000000000000000000000000000")).toBe(
      false,
    );
    expect(isValidTronAddress("")).toBe(false);
    expect(isValidTronAddress("T")).toBe(false);
    expect(isValidTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6")).toBe(false);
    expect(isValidTronAddress("IR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(false);
    // '0' and 'O' are not in the base58 alphabet.
    expect(isValidTronAddress("T0000000000000000000000000000000OO")).toBe(false);
  });
});

describe("Twenty-one Pay webhook verification", () => {
  const SECRET = "whsec_test_secret";
  const NOW = 1_800_000_000_000; // fixed clock

  // Variadic rather than a default param: an explicit `undefined` must mean
  // "no secret configured", not "fall back to SECRET".
  const makeClient = (...args: [] | [string | undefined]) => {
    const secret = args.length ? args[0] : SECRET;
    return new TwentyOnePayClient({
      get: (k: string) =>
        k === "TWENTYONE_PAY_WEBHOOK_SECRET" ? secret : undefined,
    } as any);
  };

  const sign = (ts: string, body: string, secret = SECRET) =>
    crypto.createHmac("sha256", secret).update(`t=${ts}.${body}`).digest("hex");

  const raw = Buffer.from(JSON.stringify({ type: "deposit.confirmed" }));
  const ts = String(Math.floor(NOW / 1000));

  it("accepts a correctly signed payload", () => {
    const headers = {
      "x-t1pay-timestamp": ts,
      "x-t1pay-signature": sign(ts, raw.toString()),
    };
    expect(makeClient().verifyWebhook(headers, raw, NOW)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const headers = {
      "x-t1pay-timestamp": ts,
      "x-t1pay-signature": sign(ts, raw.toString()),
    };
    const tampered = Buffer.from(JSON.stringify({ type: "deposit.spoofed" }));
    expect(makeClient().verifyWebhook(headers, tampered, NOW)).toBe(false);
  });

  // The failure this guards against is not an attack — it is our own
  // middleware. If the webhook route hands `verifyWebhook` a re-serialised
  // body (`Buffer.from(JSON.stringify(req.body))`) instead of the bytes 21 Pay
  // actually sent, every signature silently stops verifying. Whitespace and
  // key order do not survive a parse/stringify round trip.
  it("rejects a body that was parsed and re-serialised", () => {
    const onTheWire = '{"type": "deposit.confirmed", "amount": "1000000"}';
    const headers = {
      "x-t1pay-timestamp": ts,
      "x-t1pay-signature": sign(ts, onTheWire),
    };

    // What we must send: the original bytes.
    expect(
      makeClient().verifyWebhook(headers, Buffer.from(onTheWire), NOW),
    ).toBe(true);

    // What a JSON body-parser would hand us instead — semantically identical,
    // byte-wise different.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(onTheWire)));
    expect(reserialised.equals(Buffer.from(onTheWire))).toBe(false);
    expect(makeClient().verifyWebhook(headers, reserialised, NOW)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const headers = {
      "x-t1pay-timestamp": ts,
      "x-t1pay-signature": sign(ts, raw.toString(), "wrong_secret"),
    };
    expect(makeClient().verifyWebhook(headers, raw, NOW)).toBe(false);
  });

  it("rejects replayed deliveries outside the tolerance window", () => {
    const oldTs = String(Math.floor(NOW / 1000) - 600); // 10 min old
    const headers = {
      "x-t1pay-timestamp": oldTs,
      "x-t1pay-signature": sign(oldTs, raw.toString()),
    };
    expect(makeClient().verifyWebhook(headers, raw, NOW)).toBe(false);
  });

  it("returns false (does not throw) on a short signature", () => {
    // The provider's sample calls timingSafeEqual directly, which THROWS on a
    // length mismatch — turning a hostile request into a 500.
    const headers = { "x-t1pay-timestamp": ts, "x-t1pay-signature": "ab" };
    expect(() => makeClient().verifyWebhook(headers, raw, NOW)).not.toThrow();
    expect(makeClient().verifyWebhook(headers, raw, NOW)).toBe(false);
  });

  it("returns false on non-hex, missing, and malformed headers", () => {
    const good = sign(ts, raw.toString());
    expect(
      makeClient().verifyWebhook(
        { "x-t1pay-timestamp": ts, "x-t1pay-signature": "z".repeat(64) },
        raw,
        NOW,
      ),
    ).toBe(false);
    expect(makeClient().verifyWebhook({ "x-t1pay-signature": good }, raw, NOW)).toBe(
      false,
    );
    expect(makeClient().verifyWebhook({ "x-t1pay-timestamp": ts }, raw, NOW)).toBe(
      false,
    );
    expect(
      makeClient().verifyWebhook(
        { "x-t1pay-timestamp": "not-a-number", "x-t1pay-signature": good },
        raw,
        NOW,
      ),
    ).toBe(false);
  });

  it("rejects when the raw body is unavailable", () => {
    const headers = {
      "x-t1pay-timestamp": ts,
      "x-t1pay-signature": sign(ts, raw.toString()),
    };
    expect(makeClient().verifyWebhook(headers, undefined, NOW)).toBe(false);
    expect(makeClient().verifyWebhook(headers, Buffer.alloc(0), NOW)).toBe(false);
  });

  it("rejects everything when no webhook secret is configured", () => {
    const headers = {
      "x-t1pay-timestamp": ts,
      "x-t1pay-signature": sign(ts, raw.toString()),
    };
    expect(makeClient(undefined).verifyWebhook(headers, raw, NOW)).toBe(false);
  });
});

describe("EVM address validation", () => {
  // The canonical EIP-55 vectors from the specification.
  const CHECKSUMMED = [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];

  it("accepts canonical EIP-55 checksummed addresses", () => {
    for (const a of CHECKSUMMED) {
      expect({ a, valid: isValidEvmAddress(a) }).toEqual({ a, valid: true });
    }
  });

  it("accepts unchecksummed all-lower and all-upper forms", () => {
    // No mixed case means no checksum is being claimed, so there is nothing to
    // verify and shape alone is enough.
    expect(isValidEvmAddress(CHECKSUMMED[0].toLowerCase())).toBe(true);
    expect(isValidEvmAddress("0x" + CHECKSUMMED[0].slice(2).toUpperCase())).toBe(
      true,
    );
  });

  it("rejects a checksummed address with a single letter's case flipped", () => {
    // The test that proves EIP-55 is actually computed rather than stubbed:
    // the address is still 40 valid hex characters, so only the checksum can
    // catch it. This is the typo that would otherwise cost a user their funds.
    for (const a of CHECKSUMMED) {
      const body = a.slice(2);
      const i = [...body].findIndex((c) => /[a-zA-Z]/.test(c));
      const flipped =
        body[i] === body[i].toUpperCase()
          ? body[i].toLowerCase()
          : body[i].toUpperCase();
      const corrupted = "0x" + body.slice(0, i) + flipped + body.slice(i + 1);

      expect(corrupted).not.toEqual(a);
      expect({ corrupted, valid: isValidEvmAddress(corrupted) }).toEqual({
        corrupted,
        valid: false,
      });
    }
  });

  it("rejects malformed, truncated and over-length input", () => {
    expect(isValidEvmAddress("0x")).toBe(false);
    expect(isValidEvmAddress(CHECKSUMMED[0].slice(0, 41))).toBe(false);
    expect(isValidEvmAddress(CHECKSUMMED[0] + "a")).toBe(false);
    expect(isValidEvmAddress(CHECKSUMMED[0].replace("0x", ""))).toBe(false);
    expect(isValidEvmAddress("0xZZZZb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(
      false,
    );
    expect(isValidEvmAddress("" as any)).toBe(false);
    expect(isValidEvmAddress(null as any)).toBe(false);
  });
});

describe("address validation is network-aware", () => {
  const TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

  it("accepts each format on its own network", () => {
    expect(isValidAddressForNetwork(CryptoNetwork.TRON, TRON)).toBe(true);
    for (const n of [
      CryptoNetwork.BASE,
      CryptoNetwork.POLYGON,
      CryptoNetwork.ARBITRUM,
    ]) {
      expect({ n, valid: isValidAddressForNetwork(n, EVM) }).toEqual({
        n,
        valid: true,
      });
    }
  });

  it("rejects each format on the other family's network", () => {
    expect(isValidAddressForNetwork(CryptoNetwork.TRON, EVM)).toBe(false);
    expect(isValidAddressForNetwork(CryptoNetwork.BASE, TRON)).toBe(false);
  });

  it("cannot tell the three EVM chains apart — documented, not a defect", () => {
    // A Base address is indistinguishable from a Polygon one. Nothing here can
    // fix that; the network is bound to the stored address record instead.
    expect(isValidAddressForNetwork(CryptoNetwork.BASE, EVM)).toBe(
      isValidAddressForNetwork(CryptoNetwork.ARBITRUM, EVM),
    );
  });
});

describe("TWENTYONE_PAY_NETWORKS parsing", () => {
  it("parses the launch set, trimming and de-duplicating", () => {
    expect(parseEnabledNetworks("tron,base,polygon,arbitrum")).toEqual([
      "tron",
      "base",
      "polygon",
      "arbitrum",
    ]);
    expect(parseEnabledNetworks(" TRON , base ,base ")).toEqual([
      "tron",
      "base",
    ]);
  });

  it("returns an empty list when unset", () => {
    expect(parseEnabledNetworks(undefined)).toEqual([]);
    expect(parseEnabledNetworks("")).toEqual([]);
  });

  it("throws on an unsupported network rather than skipping it", () => {
    // Silently dropping a typo means a chain we cannot watch is either offered
    // or withheld without anyone noticing. Fail at boot instead.
    expect(() => parseEnabledNetworks("tron,ethereum")).toThrow(/ethereum/);
    expect(() => parseEnabledNetworks("ton")).toThrow(/ton/);
    expect(() => parseEnabledNetworks("torn")).toThrow(/torn/);
  });
});
