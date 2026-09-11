import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

export const SESSION_COOKIE = "sa_session";

function sign(payload: string) {
  return createHmac("sha256", config.auth.sessionSecret).update(payload).digest("base64url");
}

export function createSessionToken() {
  const expires = Date.now() + config.auth.sessionDays * 86_400_000;
  const payload = String(expires);
  return { token: `${payload}.${sign(payload)}`, expires: new Date(expires) };
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token || !config.auth.sessionSecret) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

export function checkPassword(input: string) {
  const expected = config.auth.password;
  if (!expected) return false;
  const a = Buffer.from(sign(input));
  const b = Buffer.from(sign(expected));
  return timingSafeEqual(a, b);
}

export function authConfigured() {
  return Boolean(config.auth.password && config.auth.sessionSecret);
}
