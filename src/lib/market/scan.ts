import {
  evaluateMarketQuality,
  type MarketQualityResult,
} from "./quality";

export type ScanOutcome = "PASS" | "EXCLUDE" | "NEEDS_DATA";

export type ScanPolicy = {
  version: string;
  maxSnapshotAgeMs: number;
  minimumLiquidityUsd: number;
  minimumVolume24hUsd: number;
  maximumSpreadPct: number;
  minimumInstrumentAgeMs: number;
  minimumPriceChange24hPct: number;
  maximumPriceChange24hPct: number;
};

export type ScanSnapshot = {
  eventTime: string | null;
  receivedAt: string;
  sequence: number | null;
  previousSequence?: number | null;
  independentSourceLineages: string[];
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  spreadPct: number | null;
  instrumentCreatedAt: string | null;
  priceChange24hPct: number | null;
};

export type ScanResult = {
  outcome: ScanOutcome;
  policyVersion: string;
  quality: MarketQualityResult;
  failedRules: string[];
  missingFields: string[];
  eligibleUntil: string | null;
};

function assertFiniteThreshold(value: number, label: string, allowZero = true): void {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be a finite ${allowZero ? "non-negative" : "positive"} number.`);
  }
}

function isFiniteMetric(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

export function evaluateScanSnapshot(input: {
  snapshot: ScanSnapshot;
  policy: ScanPolicy;
  now: string;
}): ScanResult {
  const { snapshot, policy, now } = input;
  if (!policy.version.trim()) {
    throw new Error("A versioned scan policy is required.");
  }

  assertFiniteThreshold(policy.maxSnapshotAgeMs, "maxSnapshotAgeMs", false);
  assertFiniteThreshold(policy.minimumLiquidityUsd, "minimumLiquidityUsd");
  assertFiniteThreshold(policy.minimumVolume24hUsd, "minimumVolume24hUsd");
  assertFiniteThreshold(policy.maximumSpreadPct, "maximumSpreadPct");
  assertFiniteThreshold(policy.minimumInstrumentAgeMs, "minimumInstrumentAgeMs");
  if (!Number.isFinite(policy.minimumPriceChange24hPct) ||
      !Number.isFinite(policy.maximumPriceChange24hPct) ||
      policy.minimumPriceChange24hPct > policy.maximumPriceChange24hPct) {
    throw new Error("Price-change policy bounds must be finite and ordered.");
  }

  const quality = evaluateMarketQuality({
    eventTime: snapshot.eventTime,
    receivedAt: snapshot.receivedAt,
    now,
    maxAgeMs: policy.maxSnapshotAgeMs,
    sequence: snapshot.sequence,
    previousSequence: snapshot.previousSequence,
    independentSourceLineages: snapshot.independentSourceLineages,
  });

  const missingFields: string[] = [];
  const failedRules: string[] = [];
  if (!isFiniteMetric(snapshot.liquidityUsd) || snapshot.liquidityUsd < 0) {
    missingFields.push("liquidity_usd");
  } else if (snapshot.liquidityUsd < policy.minimumLiquidityUsd) {
    failedRules.push("minimum_liquidity_usd");
  }
  if (!isFiniteMetric(snapshot.volume24hUsd) || snapshot.volume24hUsd < 0) {
    missingFields.push("volume_24h_usd");
  } else if (snapshot.volume24hUsd < policy.minimumVolume24hUsd) {
    failedRules.push("minimum_volume_24h_usd");
  }
  if (!isFiniteMetric(snapshot.spreadPct) || snapshot.spreadPct < 0) {
    missingFields.push("spread_pct");
  } else if (snapshot.spreadPct > policy.maximumSpreadPct) {
    failedRules.push("maximum_spread_pct");
  }
  if (!snapshot.instrumentCreatedAt) {
    missingFields.push("instrument_created_at");
  } else {
    const createdAtMs = Date.parse(snapshot.instrumentCreatedAt);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs) {
      missingFields.push("instrument_created_at");
    } else if (nowMs - createdAtMs < policy.minimumInstrumentAgeMs) {
      failedRules.push("minimum_instrument_age_ms");
    }
  }
  if (!isFiniteMetric(snapshot.priceChange24hPct)) {
    missingFields.push("price_change_24h_pct");
  } else {
    if (snapshot.priceChange24hPct < policy.minimumPriceChange24hPct) {
      failedRules.push("minimum_price_change_24h_pct");
    }
    if (snapshot.priceChange24hPct > policy.maximumPriceChange24hPct) {
      failedRules.push("maximum_price_change_24h_pct");
    }
  }

  const isQualityReady = quality.status === "ready";
  const outcome: ScanOutcome =
    !isQualityReady || missingFields.length > 0
      ? "NEEDS_DATA"
      : failedRules.length > 0
        ? "EXCLUDE"
        : "PASS";

  const qualityIsFresh =
    quality.ageMs !== null &&
    quality.ageMs >= -500 &&
    quality.ageMs <= policy.maxSnapshotAgeMs;

  return {
    outcome,
    policyVersion: policy.version,
    quality,
    failedRules,
    missingFields,
    eligibleUntil:
      outcome === "PASS" && qualityIsFresh
        ? new Date(Date.parse(snapshot.eventTime!) + policy.maxSnapshotAgeMs).toISOString()
        : null,
  };
}
