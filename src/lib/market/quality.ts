export type MarketQualityStatus =
  | "ready"
  | "needs_data"
  | "stale"
  | "future_timestamp"
  | "out_of_order"
  | "sequence_gap";

export type MarketQualityResult = {
  status: MarketQualityStatus;
  reasons: string[];
  ageMs: number | null;
};

const qualityPriority: Record<MarketQualityStatus, number> = {
  ready: 0,
  needs_data: 1,
  stale: 2,
  out_of_order: 3,
  sequence_gap: 4,
  future_timestamp: 5,
};

export function evaluateMarketQuality(input: {
  eventTime: string | null;
  receivedAt: string;
  now: string;
  maxAgeMs: number;
  sequence: number | null;
  previousSequence?: number | null;
  independentSourceLineages: string[];
}): MarketQualityResult {
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
    throw new Error("maxAgeMs must be a positive finite number.");
  }

  const receivedAtMs = Date.parse(input.receivedAt);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(receivedAtMs) || !Number.isFinite(nowMs)) {
    throw new Error("receivedAt and now must be valid timestamps.");
  }

  const reasons: string[] = [];
  let ageMs: number | null = null;
  let status: MarketQualityStatus = "ready";
  const fail = (nextStatus: MarketQualityStatus, reason: string) => {
    reasons.push(reason);
    if (qualityPriority[nextStatus] > qualityPriority[status]) {
      status = nextStatus;
    }
  };

  if (receivedAtMs - nowMs > 500) {
    fail("future_timestamp", "received_at_in_future");
  }

  if (!input.eventTime) {
    fail("needs_data", "event_time_missing");
  } else {
    const eventTimeMs = Date.parse(input.eventTime);
    if (!Number.isFinite(eventTimeMs)) {
      fail("needs_data", "event_time_invalid");
    } else {
      ageMs = nowMs - eventTimeMs;
      if (ageMs < -500) {
        fail("future_timestamp", "event_time_in_future");
      } else if (ageMs > input.maxAgeMs) {
        fail("stale", "event_stale");
      }
    }
  }

  if (input.sequence === null || !Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    fail("needs_data", "sequence_missing");
  } else if (input.previousSequence !== undefined && input.previousSequence !== null) {
    if (!Number.isSafeInteger(input.previousSequence) || input.previousSequence < 0) {
      throw new Error("previousSequence must be a non-negative safe integer when provided.");
    }
    if (input.sequence <= input.previousSequence) {
      fail("out_of_order", "sequence_not_increasing");
    } else if (input.sequence > input.previousSequence + 1) {
      fail("sequence_gap", "sequence_gap_detected");
    }
  }

  const independentLineages = new Set(
    input.independentSourceLineages.map((lineage) => lineage.trim()).filter(Boolean),
  );
  if (independentLineages.size < 2) {
    fail("needs_data", "insufficient_independent_sources");
  }

  return { status, reasons, ageMs };
}
