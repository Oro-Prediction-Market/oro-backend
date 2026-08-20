import * as crypto from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import { CryptoNetwork, EVM_NETWORKS } from "./services/twentyone-pay/twentyone-pay.types";

/** USDT has 6 decimals on both TRC-20 and TON. */
export const USDT_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDT_DECIMALS);


export function toBaseUnits(human: string | number): string {
  // Trailing zeros are not precision. Money columns are `numeric(28,9)`, so
  // Postgres hands back "25.500000000" for a value that was written as 25.5 —
  // nine decimal places, none of them significant. Trimming them first means a
  // round trip through the database does not turn a valid amount into a
  // rejected one, while genuine over-precision like "1.0000001" still fails.
  const s = String(human)
    .trim()
    .replace(/^(\d+\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new Error(
      `Invalid USDT amount "${s}" — expected a non-negative decimal with at most ${USDT_DECIMALS} places`,
    );
  }
  const [whole, frac = ""] = s.split(".");
  return (BigInt(whole) * SCALE + BigInt(frac.padEnd(USDT_DECIMALS, "0"))).toString();
}

/** Convert base units ("1500000") to a human string ("1.5"). Exact, no rounding. */
export function fromBaseUnits(base: string | bigint): string {
  const v = BigInt(base);
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(USDT_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Buffer | null {
  let num = 0n;
  for (const ch of input) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  // Leading '1's in base58 encode leading zero bytes.
  for (const ch of input) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}


export function isValidTronAddress(address: string): boolean {
  if (typeof address !== "string" || address.length !== 34 || !address.startsWith("T")) {
    return false;
  }
  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25) return false;
  if (decoded[0] !== 0x41) return false;

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const hash = crypto
    .createHash("sha256")
    .update(crypto.createHash("sha256").update(payload).digest())
    .digest();
  return hash.subarray(0, 4).equals(checksum);
}


export function isValidEvmAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;

  const body = address.slice(2);
  const hasUpper = /[A-F]/.test(body);
  const hasLower = /[a-f]/.test(body);
  if (!hasUpper || !hasLower) return true; // unchecksummed, nothing to verify

  const lower = body.toLowerCase();
  const hash = Buffer.from(keccak_256(Buffer.from(lower, "ascii"))).toString(
    "hex",
  );

  for (let i = 0; i < 40; i++) {
    const shouldBeUpper = parseInt(hash[i], 16) >= 8;
    const ch = body[i];
    if (/[0-9]/.test(ch)) continue; // digits carry no case
    if (shouldBeUpper !== (ch === ch.toUpperCase())) return false;
  }
  return true;
}


export function isValidAddressForNetwork(
  network: CryptoNetwork,
  address: string,
): boolean {
  if (network === CryptoNetwork.TRON) return isValidTronAddress(address);
  if (EVM_NETWORKS.has(network)) return isValidEvmAddress(address);
  return false;
}
