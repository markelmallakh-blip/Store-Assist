import { withAutoRecipes } from "@/lib/bundles";
import { gql } from "./client";
import type { Component, Variant } from "@/lib/types";

const CATALOG_QUERY = /* GraphQL */ `
  query Catalog($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      nodes {
        id
        title
        sku
        barcode
        price
        inventoryQuantity
        selectedOptions { name value }
        inventoryItem { id tracked unitCost { amount } }
        product {
          id
          title
          status
          productType
          vendor
          featuredMedia { preview { image { url(transform: { maxWidth: 160 }) } } }
        }
        components: metafield(namespace: "store_assist", key: "components") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type RawVariant = {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string; tracked: boolean; unitCost: { amount: string } | null };
  product: {
    id: string;
    title: string;
    status: string;
    productType: string;
    vendor: string;
    featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  };
  components: { value: string } | null;
};

export function parseComponents(value: string | null | undefined): Component[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const list = parsed
      .filter((c) => c && typeof c.variantId === "string" && Number(c.qty) > 0)
      .map((c) => ({ variantId: c.variantId as string, qty: Math.round(Number(c.qty)) }));
    return list.length ? list : null;
  } catch {
    return null;
  }
}

function toVariant(v: RawVariant): Variant {
  const variantTitle = v.title === "Default Title" ? null : v.title;
  return {
    id: v.id,
    productId: v.product.id,
    productTitle: v.product.title,
    variantTitle,
    name: variantTitle ? `${v.product.title} — ${variantTitle}` : v.product.title,
    sku: v.sku || null,
    barcode: v.barcode || null,
    price: Number(v.price),
    shopifyQty: v.inventoryQuantity ?? 0,
    tracked: v.inventoryItem.tracked,
    inventoryItemId: v.inventoryItem.id,
    cost: v.inventoryItem.unitCost ? Number(v.inventoryItem.unitCost.amount) : null,
    status: v.product.status,
    productType: v.product.productType,
    vendor: v.product.vendor,
    image: v.product.featuredMedia?.preview?.image?.url ?? null,
    options: v.selectedOptions.filter((o) => o.name !== "Title"),
    components: parseComponents(v.components?.value),
    notBundle: v.components?.value?.trim() === "[]",
    recipeSource: parseComponents(v.components?.value) ? "saved" : null,
  };
}

let cache: { at: number; variants: Variant[] } | null = null;
const TTL_MS = 60_000;

/** All product variants (except archived products). Cached in memory for a minute. */
export async function getCatalog(opts: { fresh?: boolean } = {}): Promise<Variant[]> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.variants;

  const out: Variant[] = [];
  let cursor: string | null = null;
  do {
    const data: { productVariants: { nodes: RawVariant[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } =
      await gql(CATALOG_QUERY, { cursor });
    for (const node of data.productVariants.nodes) {
      if (node.product.status !== "ARCHIVED") out.push(toVariant(node));
    }
    cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (cursor);

  // Multipacks like "2 Jars …" count as their singles by default, before anyone opens the Bundles page.
  const variants = withAutoRecipes(out);
  cache = { at: Date.now(), variants };
  return variants;
}

export function invalidateCatalog() {
  cache = null;
}

export function byId(variants: Variant[]) {
  return new Map(variants.map((v) => [v.id, v]));
}
