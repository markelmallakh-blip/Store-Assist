import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Everything is behind the admin password except the login page, Shopify webhooks and the cron hook
// (those verify their own signatures).
export function proxy(request: NextRequest) {
  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = request.nextUrl.pathname === "/" ? "" : `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!login|api/auth|api/webhooks|api/cron|_next/static|_next/image|favicon.ico|icon.svg|apple-icon|manifest.webmanifest).*)",
  ],
};
