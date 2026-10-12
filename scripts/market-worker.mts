import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runWorkerOnce } from "../src/lib/market/crawler.ts";

// Deliberately does not load .env.local: the worker must receive an explicit server-only environment.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Worker requires SUPABASE_URL and server-only SUPABASE_SERVICE_ROLE_KEY.");
const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }, db: { retry: false, timeout: 5000 },
});
const workerId = randomUUID();
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
const store = {
  async claim(id: string) {
    const { data, error } = await db.rpc("claim_market_crawl", { target_worker_id: id });
    if (error) throw new Error(`Claim failed (${error.code}); no provider request sent.`);
    return data;
  },
  async finish(runId: string, token: string, result: unknown) {
    const { data, error } = await db.rpc("finish_market_crawl", { target_run_id: runId, target_lease_token: token, target_result: result });
    if (error) throw new Error(`Finish unconfirmed (${error.code}); lease recovery required.`);
    return data;
  },
};
do {
  try {
    const result = await runWorkerOnce(store, workerId);
    if (result.status === "processed") console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Worker error");
    if (process.argv.includes("--once")) process.exitCode = 1;
  }
  if (process.argv.includes("--once") || stopping) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
} while (!stopping);
