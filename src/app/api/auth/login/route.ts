import { NextResponse } from "next/server";
import { authConfigured, checkPassword, createSessionToken, SESSION_COOKIE } from "@/lib/auth";

export async function POST(request: Request) {
  // Accepts JSON (from the login page script) or a plain form post (if the script hasn't loaded yet).
  const isForm = (request.headers.get("content-type") ?? "").includes("form");
  const fail = (error: string, status: number) =>
    isForm
      ? NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, request.url), 303)
      : NextResponse.json({ error }, { status });

  if (!authConfigured()) return fail("Set ADMIN_PASSWORD and SESSION_SECRET in the environment first.", 500);

  const password = isForm
    ? String((await request.formData()).get("password") ?? "")
    : ((await request.json().catch(() => ({}))) as { password?: string }).password;
  if (!password || !checkPassword(password)) {
    await new Promise((r) => setTimeout(r, 600));
    return fail("Wrong password", 401);
  }
  const { token, expires } = createSessionToken();
  const res = isForm ? NextResponse.redirect(new URL("/", request.url), 303) : NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
  return res;
}
