"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublicConfig } from "./config";

export function createSupabaseBrowserClient() {
  const config = getSupabasePublicConfig();
  if (!config) {
    throw new Error("Supabase Auth is not configured. Set the public Supabase URL and key.");
  }

  return createBrowserClient(config.url, config.key);
}
