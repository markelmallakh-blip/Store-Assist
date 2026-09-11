import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { syncOrder } from "@/lib/order-sync";
import { getRecentlyUpdatedOrderIds } from "@/lib/shopify/orders";

export const maxDuration = 300;

/**
 * Safety net for missed webhooks: re-sync every order touched in the last 26 hours.
 * Vercel Cron calls this with "Authorization: Bearer <CRON_SECRET>".
 */
export async function GET(request: Request) {
  if (!config.cronSecret || request.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ids = await getRecentlyUpdatedOrderIds(26);
  const results = [];
  for (const id of ids) {
    try {
      results.push(await syncOrder(id));
    } catch (e) {
      results.push({ order: id, status: "error", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ checked: ids.length, changed: results.filter((r) => r.status === "applied").length, results });
}
