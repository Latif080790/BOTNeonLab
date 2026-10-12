import { NextRequest, NextResponse } from "next/server";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/server";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

function safeReturnPath(value: string | null, origin: string): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  const target = new URL(value, origin);
  return target.origin === origin ? `${target.pathname}${target.search}${target.hash}` : "/";
}

export async function GET(request: NextRequest) {
  if (!getSupabasePublicConfig()) {
    return NextResponse.redirect(new URL("/login?error=configuration", request.url));
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=verification", request.url));
  }

  const supabase = await createSupabaseRouteHandlerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL("/login?error=verification", request.url));
  }

  const destination = safeReturnPath(request.nextUrl.searchParams.get("next"), request.nextUrl.origin);
  return NextResponse.redirect(new URL(destination, request.url));
}
