import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublicConfig } from "./config";

async function createSupabaseClient(allowCookieWrites: boolean) {
  const cookieStore = await cookies();
  const config = getSupabasePublicConfig();
  if (!config) {
    throw new Error("Supabase Auth is not configured. Set the public Supabase URL and key.");
  }

  return createServerClient(config.url, config.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        if (!allowCookieWrites) {
          throw new Error("Server Components cannot write auth cookies; the request proxy must refresh the session.");
        }
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}

export function createSupabaseServerClient() {
  return createSupabaseClient(false);
}

export function createSupabaseActionClient() {
  return createSupabaseClient(true);
}

export function createSupabaseRouteHandlerClient() {
  return createSupabaseClient(true);
}
