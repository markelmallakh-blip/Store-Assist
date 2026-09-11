import { handle } from "@/lib/api";
import { markOrderConfirmed } from "@/lib/shopify/mutations";

export const POST = handle(async (request: Request) => {
  const { orderId, value = true } = (await request.json()) as { orderId: string; value?: boolean };
  if (!orderId?.startsWith("gid://shopify/Order/")) throw new Error("Missing orderId");
  await markOrderConfirmed(orderId, value);
  return { ok: true };
});
