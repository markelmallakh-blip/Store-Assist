import { handle } from "@/lib/api";
import { receiptReady } from "@/lib/config";
import { getCatalog } from "@/lib/shopify/catalog";
import { purchasableCatalog } from "@/lib/receipt";

/** Lightweight list of single (non-bundle) products, for pickers and manual search. */
export const GET = handle(async () => {
  const catalog = await getCatalog();
  return {
    claudeReady: receiptReady(),
    items: purchasableCatalog(catalog)
      .map((v) => ({
        id: v.id,
        name: v.name,
        image: v.image,
        sku: v.sku,
        vendor: v.vendor,
        status: v.status,
        cost: v.cost,
        shopifyQty: v.shopifyQty,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
});
