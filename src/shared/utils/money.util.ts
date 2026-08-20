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

export { BTN_CURRENCY };
