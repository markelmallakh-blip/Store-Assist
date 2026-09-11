import { handle } from "@/lib/api";
import { componentPool, looksLikeBundle, suggestRecipe } from "@/lib/bundles";
import { byId, getCatalog, invalidateCatalog } from "@/lib/shopify/catalog";
import { saveBundleComponents } from "@/lib/shopify/mutations";
import type { Component } from "@/lib/types";

export const GET = handle(async () => {
  const catalog = await getCatalog();
  const map = byId(catalog);
  const groups = new Map<
    string,
    {
      productId: string;
      productTitle: string;
      image: string | null;
      productType: string;
      vendor: string;
      status: string;
      variants: {
        variantId: string;
        variantTitle: string | null;
        name: string;
        notBundle: boolean;
        source: "saved" | "auto" | null;
        components: (Component & { name: string })[] | null;
        suggestion: { variantId: string; qty: number; confidence: number; label: string }[];
      }[];
    }
  >();

  for (const v of catalog) {
    if (!looksLikeBundle(v) && !v.notBundle) continue;
    const g = groups.get(v.productId) ?? {
      productId: v.productId,
      productTitle: v.productTitle,
      image: v.image,
      productType: v.productType,
      vendor: v.vendor,
      status: v.status,
      variants: [],
    };
    g.variants.push({
      variantId: v.id,
      variantTitle: v.variantTitle,
      name: v.name,
      notBundle: v.notBundle,
      source: v.recipeSource,
      components: v.components?.map((c) => ({ ...c, name: map.get(c.variantId)?.name ?? "Unknown item" })) ?? null,
      suggestion: v.components || v.notBundle ? [] : suggestRecipe(v, catalog),
    });
    groups.set(v.productId, g);
  }

  const products = [...groups.values()].sort((a, b) => {
    const pending = (p: typeof a) => p.variants.filter((v) => !v.components && !v.notBundle).length;
    return Number(pending(b) > 0) - Number(pending(a) > 0) || Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE") || a.productTitle.localeCompare(b.productTitle);
  });

  const singles = componentPool(catalog)
    .map((v) => ({ id: v.id, name: v.name, image: v.image, sku: v.sku, status: v.status }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { products, singles };
});

export const POST = handle(async (request: Request) => {
  const { entries } = (await request.json()) as { entries: { variantId: string; components: Component[] | null }[] };
  if (!Array.isArray(entries) || !entries.length) throw new Error("Nothing to save");
  const clean = entries.map((e) => ({
    variantId: e.variantId,
    components:
      e.components === null
        ? null
        : e.components
            .filter((c) => c.variantId && c.variantId !== e.variantId && Number(c.qty) > 0)
            .map((c) => ({ variantId: c.variantId, qty: Math.round(Number(c.qty)) })),
  }));
  await saveBundleComponents(clean);
  invalidateCatalog();
  return { ok: true, saved: clean.length };
});
