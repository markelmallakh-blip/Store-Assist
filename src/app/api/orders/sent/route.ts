import { handle } from "@/lib/api";
import { config } from "@/lib/config";
import { addOrderTags } from "@/lib/shopify/mutations";

/** Mark "confirmation message sent" by tagging the order (same tag CK automation can add later). */
export const POST = handle(async (request: Request) => {
  const { orderId } = (await request.json()) as { orderId: string };
  if (!orderId?.startsWith("gid://shopify/Order/")) throw new Error("Missing orderId");
  await addOrderTags(orderId, [config.confirmation.sentTag]);
  return { ok: true };
});
