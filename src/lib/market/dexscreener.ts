import { z } from "zod";
import { normalizeDexIdentity } from "./identity.ts";
import { evaluateMarketQuality, type MarketQualityStatus } from "./quality.ts";

const DexPairSchema = z.object({
  chainId: z.string().trim().min(1).max(64),
  dexId: z.string().trim().min(1).max(64),
  pairAddress: z.string().trim().min(1).max(256),
  baseToken: z.object({
    address: z.string().trim().min(1).max(256),
    name: z.string().max(120),
    symbol: z.string().max(64),
  }),
  quoteToken: z.object({
    address: z.string().trim().max(256).nullable().optional(),
    name: z.string().max(120).nullable().optional(),
    symbol: z.string().max(64).nullable().optional(),
  }),
  priceUsd: z.string().nullable().optional(),
  liquidity: z.object({
    usd: z.number().finite().nonnegative().nullable().optional(),
  }).nullable().optional(),
  volume: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  pairCreatedAt: z.number().int().nonnegative().nullable().optional(),
}).passthrough();

const DexSearchResponseSchema = z.object({
  pairs: z.array(DexPairSchema).max(500).nullable(),
}).passthrough();

export class DexProviderSchemaError extends Error {
  constructor() {
    super("DEX Screener returned a response with an unsupported schema.");
    this.name = "DexProviderSchemaError";
  }
}

export type DexSearchObservation = {
  instrument: ReturnType<typeof normalizeDexIdentity>;
  source: "dexscreener";
  sourceLineage: "dexscreener";
  sourceEventId: null;
  eventTime: null;
  receivedAt: string;
  sequence: null;
  schemaVersion: "dexscreener-search-v1";
  qualityStatus: MarketQualityStatus;
  qualityReasons: string[];
  name: string;
  symbol: string;
  quoteSymbol: string | null;
  dexId: string;
  priceUsd: string | null;
  liquidityUsd: number | null;
  pairCreatedAt: number | null;
};

export function parseDexSearchResponse(
  body: unknown,
  receivedAt: string,
): {
  observations: DexSearchObservation[];
  duplicatePairCount: number;
  invalidPairCount: number;
} {
  const parsed = DexSearchResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DexProviderSchemaError();
  }

  const observations = new Map<string, DexSearchObservation>();
  let duplicatePairCount = 0;
  let invalidPairCount = 0;
  const pairs = parsed.data.pairs ?? [];

  for (const pair of pairs) {
    let identity: ReturnType<typeof normalizeDexIdentity>;
    try {
      identity = normalizeDexIdentity({
        chainId: pair.chainId,
        mint: pair.baseToken.address,
        poolAddress: pair.pairAddress,
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      invalidPairCount += 1;
      continue;
    }

    if (observations.has(identity.canonicalId)) {
      duplicatePairCount += 1;
      continue;
    }

    const quality = evaluateMarketQuality({
      eventTime: null,
      receivedAt,
      now: receivedAt,
      maxAgeMs: 120_000,
      sequence: null,
      independentSourceLineages: ["dexscreener"],
    });

    observations.set(identity.canonicalId, {
      instrument: identity,
      source: "dexscreener",
      sourceLineage: "dexscreener",
      sourceEventId: null,
      eventTime: null,
      receivedAt,
      sequence: null,
      schemaVersion: "dexscreener-search-v1",
      qualityStatus: quality.status,
      qualityReasons: quality.reasons,
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      quoteSymbol: pair.quoteToken.symbol ?? null,
      dexId: pair.dexId,
      priceUsd: pair.priceUsd ?? null,
      liquidityUsd: pair.liquidity?.usd ?? null,
      pairCreatedAt: pair.pairCreatedAt ?? null,
    });
  }

  return {
    observations: [...observations.values()],
    duplicatePairCount,
    invalidPairCount,
  };
}
