import { randomUUID } from "node:crypto";
import { fetchCrawlAttempt } from "../src/lib/market/crawler.ts";

// Read-only live provider smoke. No database writes, signals or orders.
const now = Date.now();
const result = await fetchCrawlAttempt({
  id: randomUUID(), lease_token: randomUUID(), attempts: 1, query: "USDC",
  deadline_at: new Date(now + 30000).toISOString(), lease_until: new Date(now + 10000).toISOString(),
});
console.log(JSON.stringify({
  ok: result.ok, code: result.code,
  observations: "observations" in result ? result.observations.length : 0,
  qualityStatuses: "observations" in result ? [...new Set(result.observations.map((o) => o.quality_status))] : [],
  tradingEligible: false,
}, null, 2));
if (!result.ok) process.exitCode = 1;
