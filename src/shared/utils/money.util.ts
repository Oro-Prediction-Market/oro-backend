import { BTN_CURRENCY } from "../../entities/transaction.entity";

export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  BTN: 2,
  USDT: 6,
};

export function moneyDecimals(currency: string): number {
  const dp = CURRENCY_DECIMALS[currency];
  if (dp === undefined) {
    throw new Error(
      `No decimal precision defined for currency "${currency}". ` +
        `Add it to CURRENCY_DECIMALS before using it on a money path.`,
    );
  }
  return dp;
}

export function roundMoney(value: number, currency: string): number {
  return parseFloat(value.toFixed(moneyDecimals(currency)));
}

export function floorMoney(value: number, currency: string): number {
  const factor = 10 ** moneyDecimals(currency);
  return Math.floor(value * factor) / factor;
}

/**
 * How each currency is written in text a user reads.
 *
 * Ngultrum leads with its symbol the way the rest of the product does; USDT
 * trails its ticker, because "Nu 0.5 USDT" is nonsense and "$" is not what a
 * stablecoin balance is. A currency with decimals but no entry here falls back
 * to a trailing ticker rather than throwing — this is display text, and a
 * missing label should not take down a settlement.
 */
const CURRENCY_LABELS: Readonly<
  Record<string, { prefix?: string; suffix?: string }>
> = {
  BTN: { prefix: "Nu " },
  USDT: { suffix: " USDT" },
};

/**
 * Render an amount for a note, a Telegram message or an error a user sees.
 *
 * Exists because every one of those strings used to hardcode "Nu", which was
 * true while money was ngultrum-only and became a lie the moment a USDT bond
 * could be quoted. Fixed at the currency's own precision, then trailing zeros
 * trimmed so a whole amount reads "Nu 50" rather than "Nu 50.00" and a USDT
 * figure does not carry five zeros it does not need.
 */
export function formatMoney(value: number, currency: string): string {
  let text = value.toFixed(moneyDecimals(currency));
  if (text.includes("."))
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  const label = CURRENCY_LABELS[currency];
  if (!label) return `${text} ${currency}`;
  return `${label.prefix ?? ""}${text}${label.suffix ?? ""}`;
}

export { BTN_CURRENCY };
