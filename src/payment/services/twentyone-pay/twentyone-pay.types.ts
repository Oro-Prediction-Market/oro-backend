
export enum CryptoNetwork {
  TRON = "tron",
  BASE = "base",
  POLYGON = "polygon",
  ARBITRUM = "arbitrum",
  ETHEREUM = "ethereum",
}

/** The chains sharing the EVM `0x` address format. */
export const EVM_NETWORKS: ReadonlySet<CryptoNetwork> = new Set([
  CryptoNetwork.BASE,
  CryptoNetwork.POLYGON,
  CryptoNetwork.ARBITRUM,
  CryptoNetwork.ETHEREUM,
]);

export function isCryptoNetwork(value: string): value is CryptoNetwork {
  return (Object.values(CryptoNetwork) as string[]).includes(value);
}

export function parseEnabledNetworks(raw: string | undefined): CryptoNetwork[] {
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (parts.length === 0) return [];

  const unknown = parts.filter((p) => !isCryptoNetwork(p));
  if (unknown.length > 0) {
    throw new Error(
      `TWENTYONE_PAY_NETWORKS contains unsupported network(s): ${unknown.join(", ")}. ` +
        `Supported: ${Object.values(CryptoNetwork).join(", ")}`,
    );
  }

  return [...new Set(parts as CryptoNetwork[])];
}
