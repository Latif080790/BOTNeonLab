function requiredPart(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes(":")) {
    throw new Error(`${label} must be non-empty and cannot contain a colon.`);
  }
  return normalized;
}

export type DexInstrumentIdentity = {
  kind: "dex";
  chainId: string;
  mint: string;
  poolAddress: string;
  canonicalId: string;
};

export function normalizeDexIdentity(input: {
  chainId: string;
  mint: string;
  poolAddress: string;
}): DexInstrumentIdentity {
  const chainId = requiredPart(input.chainId, "chainId");
  const mint = requiredPart(input.mint, "mint");
  const poolAddress = requiredPart(input.poolAddress, "poolAddress");

  return {
    kind: "dex",
    chainId,
    mint,
    poolAddress,
    canonicalId: `dex:${chainId}:${mint}:${poolAddress}`,
  };
}

export type CexInstrumentIdentity = {
  kind: "cex";
  venue: string;
  marketType: string;
  base: string;
  quote: string;
  symbol: string;
  canonicalId: string;
};

export function normalizeCexIdentity(input: {
  venue: string;
  marketType: string;
  base: string;
  quote: string;
  symbol: string;
}): CexInstrumentIdentity {
  const venue = requiredPart(input.venue, "venue").toLowerCase();
  const marketType = requiredPart(input.marketType, "marketType").toLowerCase();
  const base = requiredPart(input.base, "base").toUpperCase();
  const quote = requiredPart(input.quote, "quote").toUpperCase();
  const symbol = requiredPart(input.symbol, "symbol").toUpperCase();

  return {
    kind: "cex",
    venue,
    marketType,
    base,
    quote,
    symbol,
    canonicalId: `cex:${venue}:${marketType}:${base}:${quote}:${symbol}`,
  };
}
