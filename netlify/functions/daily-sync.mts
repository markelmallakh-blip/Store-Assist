import { createHash } from "node:crypto";

/**
 * Netlify scheduled function: once a day, re-sync every order touched in the last 26 hours
 * (safety net in case a Shopify webhook was missed). It calls the app's own /api/cron/sync.
 * The token matches `cronSecret` in src/lib/config.ts.
 */
export default async () => {
  const base = (process.env.APP_URL || process.env.URL || "").replace(/\/$/, "");
  const from = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_ADMIN_TOKEN;
  const token = process.env.CRON_SECRET || (from ? createHash("sha256").update(`store-assist:cron:${from}`).digest("hex") : "");
  if (!base || !token) {
    console.log("daily-sync skipped: site URL or Shopify secret not configured");
    return;
  }
  const res = await fetch(`${base}/api/cron/sync`, { headers: { authorization: `Bearer ${token}` } });
  console.log("daily-sync", res.status, (await res.text()).slice(0, 500));
};

// 01:00 UTC = 03:00/04:00 Cairo.
export const config = { schedule: "0 1 * * *" };
