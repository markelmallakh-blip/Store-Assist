import { createHmac, timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { invalidateCatalog } from "@/lib/shopify/catalog";
import { syncOrder } from "@/lib/order-sync";

export const maxDuration = 60;

function verify(body: string, hmac: string | null) {
  if (!hmac || !config.shopify.webhookSecret) return false;
  const digest = createHmac("sha256", config.shopify.webhookSecret).update(body, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmac);
  return a.length === b.length && timingSafeEqual(a, b);
}

function orderGid(topic: string, payload: Record<string, unknown>): string | null {
  // orders/create, orders/cancelled -> the order itself; orders/edited -> order_edit.order_id; refunds/create -> order_id
  const edit = payload.order_edit as { order_id?: number } | undefined;
  const id =
    topic === "orders/edited" ? edit?.order_id : topic === "refunds/create" ? (payload.order_id as number | undefined) : (payload.id as number | undefined);
  return id ? `gid://shopify/Order/${id}` : null;
}

export async function POST(request: Request) {
  const body = await request.text();
  if (!verify(body, request.headers.get("x-shopify-hmac-sha256"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  const topic = request.headers.get("x-shopify-topic") ?? "";
  const payload = JSON.parse(body) as Record<string, unknown>;
  const id = orderGid(topic, payload);

  if (id) {
    // Answer Shopify right away; do the work after the response is sent.
    after(async () => {
      try {
        invalidateCatalog();
        const result = await syncOrder(id);
        console.log(`[webhook ${topic}]`, JSON.stringify(result));
      } catch (e) {
        console.error(`[webhook ${topic}] sync failed for ${id}`, e);
      }
    });
  }
  return NextResponse.json({ ok: true });
}
