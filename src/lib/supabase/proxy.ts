import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { getSupabasePublicConfig } from "./config";

type PendingCookie = {
  name: string;
  value: string;
  options: CookieOptions;
};

function withCookies(response: NextResponse, cookies: PendingCookie[]) {
  for (const { name, value, options } of cookies) {
    response.cookies.set(name, value, options);
  }
  return response;
}

export async function updateSupabaseSession(request: NextRequest) {
  const config = getSupabasePublicConfig();
  const pathname = request.nextUrl.pathname;
  const isApiRoute = pathname.startsWith("/api/");
  const isPublicRoute =
    pathname === "/login" ||
    pathname.startsWith("/auth/callback") ||
    pathname.startsWith("/_next/");

  if (!config) {
    if (isPublicRoute) {
      return NextResponse.next({ request });
    }
    if (isApiRoute) {
      return NextResponse.json(
        { error: "Authentication service is not configured." },
        { status: 503 },
      );
    }
    return NextResponse.redirect(new URL("/login?error=configuration", request.url));
  }

  let response = NextResponse.next({ request });
  const pendingCookies: PendingCookie[] = [];
  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        pendingCookies.push(...cookiesToSet);
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [name, value] of Object.entries(headers)) {
          response.headers.set(name, value);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  if (isPublicRoute) {
    return response;
  }

  if (error && (error.status === undefined || error.status === 0 || error.status >= 500)) {
    return withCookies(
      NextResponse.json({ error: "Authentication service is temporarily unavailable." }, { status: 503 }),
      pendingCookies,
    );
  }

  if (!data?.claims?.sub) {
    if (isApiRoute) {
      return withCookies(
        NextResponse.json({ error: "Authentication is required." }, { status: 401 }),
        pendingCookies,
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return withCookies(NextResponse.redirect(loginUrl), pendingCookies);
  }

  return response;
}
