import { config, sheetEnabled } from "@/lib/config";
import { expandVariant, looksLikeBundle } from "@/lib/bundles";
import { listManualNeeds, type ManualNeed } from "@/lib/manual-needs";
import { buildSettlements, listPurchases } from "@/lib/purchase-log";
import { matchRows, readInventory } from "@/lib/sheet";
import { adminOrderUrl, adminProductUrl } from "@/lib/shopify/client";
import { byId, getCatalog } from "@/lib/shopify/catalog";
import { getOpenOrders } from "@/lib/shopify/orders";
import type {
  ConfirmationItem,
  ConfirmationState,
  Order,
  ProductRow,
  SheetRow,
  ToBuyItem,
  UnmappedBundleAlert,
  Variant,
} from "@/lib/types";

export type SheetStatus = { enabled: boolean; ok: boolean; error?: string; rows?: number; matched?: number };

async function loadSheet(variants: Variant[]): Promise<{ status: SheetStatus; matches: Map<string, SheetRow> }> {
  if (!sheetEnabled()) return { status: { enabled: false, ok: false }, matches: new Map() };
  try {
    const sheet = await readInventory();
    const matches = matchRows(sheet, variants);
    return { status: { enabled: true, ok: true, rows: sheet.rows.length, matched: matches.size }, matches };
  } catch (e) {
    return { status: { enabled: true, ok: false, error: e instanceof Error ? e.message : String(e) }, matches: new Map() };
  }
}

/** Egyptian numbers: "01xxxxxxxxx" / "+201xxxxxxxxx" -> "201xxxxxxxxx" for wa.me links. */
export function whatsappNumber(phone: string | null): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0") && d.length === 11) d = "2" + d;
  if (d.length === 10 && d.startsWith("1")) d = "20" + d;
  return d.length >= 10 ? d : null;
}

function confirmationState(o: Order): ConfirmationState | null {
  if (o.confirmed === "true") return null;
  if (o.confirmed === "false") return "declined";
  const sent = o.tags.some((t) => t.toLowerCase() === config.confirmation.sentTag.toLowerCase());
  return sent ? "sent" : "not_sent";
}

export function buildConfirmations(orders: Order[]): ConfirmationItem[] {
  const items: ConfirmationItem[] = [];
  for (const o of orders) {
    if (o.fulfillmentStatus === "FULFILLED") continue;
    const state = confirmationState(o);
    if (!state) continue;
    items.push({
      orderId: o.id,
      legacyId: o.legacyId,
      name: o.name,
      createdAt: o.createdAt,
      customerName: o.customerName,
      phone: o.phone,
      whatsapp: whatsappNumber(o.phone),
      total: o.total,
      currency: o.currency,
      state,
      fulfillmentStatus: o.fulfillmentStatus,
      sourceName: o.sourceName,
      itemsSummary: o.lines
        .filter((l) => l.currentQuantity > 0)
        .map((l) => `${l.currentQuantity}× ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`)
        .join(", "),
      adminUrl: adminOrderUrl(o.legacyId),
    });
  }
  const rank: Record<ConfirmationState, number> = { not_sent: 0, declined: 1, sent: 2 };
  return items.sort((a, b) => rank[a.state] - rank[b.state] || a.createdAt.localeCompare(b.createdAt));
}

export function buildToBuy(
  orders: Order[],
  catalog: Variant[],
  sheet: Map<string, SheetRow> | null,
  manualNeeds: ManualNeed[] = [],
): { items: ToBuyItem[]; unmapped: UnmappedBundleAlert[] } {
  const map = byId(catalog);
  const manualBy = new Map<string, ManualNeed[]>();
  for (const n of manualNeeds) manualBy.set(n.variantId, [...(manualBy.get(n.variantId) ?? []), n]);
  type Acc = { demand: number; bundleDemand: number; orders: ToBuyItem["orders"] };
  const acc = new Map<string, Acc>();
  const unmapped = new Map<string, UnmappedBundleAlert>();

  for (const o of orders) {
    if (o.cancelledAt) continue;
    for (const line of o.lines) {
      if (!line.variantId || line.unfulfilledQuantity <= 0) continue;
      const v = map.get(line.variantId);
      if (v && !v.components && looksLikeBundle(v)) {
        const u = unmapped.get(v.id) ?? { variantId: v.id, name: v.name, orders: [] };
        if (!u.orders.includes(o.name)) u.orders.push(o.name);
        unmapped.set(v.id, u);
      }
      for (const e of expandVariant(line.variantId, line.unfulfilledQuantity, map)) {
        const a = acc.get(e.variantId) ?? { demand: 0, bundleDemand: 0, orders: [] };
        a.demand += e.qty;
        if (e.viaBundle) a.bundleDemand += e.qty;
        a.orders.push({ name: o.name, legacyId: o.legacyId, qty: e.qty, viaBundle: e.viaBundle });
        acc.set(e.variantId, a);
      }
    }
  }

  const items: ToBuyItem[] = [];
  for (const v of catalog) {
    if (v.components) continue; // bundles themselves are never bought
    const a = acc.get(v.id) ?? { demand: 0, bundleDemand: 0, orders: [] };
    const row = sheet?.get(v.id);
    const actualQty = row?.qty ?? null;
    // Shopify already subtracted normal orders from "available"; bundle orders it doesn't know about.
    const shopifyEffective = v.shopifyQty - (config.syncBundlesToShopify ? 0 : a.bundleDemand);
    const reasons: string[] = [];
    let need = 0;

    if (v.tracked && shopifyEffective < 0) {
      need = Math.max(need, -shopifyEffective);
      const direct = a.demand - a.bundleDemand;
      reasons.push(
        a.bundleDemand && !config.syncBundlesToShopify
          ? `Shopify ${v.shopifyQty}, minus ${a.bundleDemand} in bundle orders`
          : direct > 0 && direct < -v.shopifyQty
            ? `Shopify stock is ${v.shopifyQty}: ${direct} for open orders, ${-v.shopifyQty - direct} shipped earlier without stock`
            : `Shopify stock is ${v.shopifyQty}`,
      );
    }
    if (actualQty !== null && actualQty < 0) {
      need = Math.max(need, -actualQty);
      reasons.push(`Actual stock is ${actualQty}`);
    }
    const manual = (manualBy.get(v.id) ?? []).map(({ id, qty, note, addedAt }) => ({ id, qty, note, addedAt }));
    need += manual.reduce((s, m) => s + m.qty, 0);
    if (need <= 0) continue;

    items.push({
      variantId: v.id,
      name: v.name,
      image: v.image,
      sku: v.sku,
      vendor: v.vendor,
      need,
      shopifyQty: v.shopifyQty,
      shopifyEffective,
      actualQty,
      openDemand: a.demand,
      bundleDemand: a.bundleDemand,
      cost: v.cost,
      orders: a.orders,
      reasons,
      forOpenOrders: a.demand > 0,
      manual,
    });
  }

  const rank = (i: ToBuyItem) => (i.forOpenOrders ? 2 : i.manual.length ? 1 : 0);
  items.sort((x, y) => rank(y) - rank(x) || y.need - x.need);
  return { items, unmapped: [...unmapped.values()] };
}

export function buildProductRows(catalog: Variant[], sheet: Map<string, SheetRow> | null): ProductRow[] {
  return catalog
    .map((v) => {
      const row = sheet?.get(v.id);
      return {
        variantId: v.id,
        productId: v.productId,
        name: v.name,
        image: v.image,
        sku: v.sku,
        vendor: v.vendor,
        productType: v.productType,
        status: v.status,
        tracked: v.tracked,
        shopifyQty: v.shopifyQty,
        actualQty: row?.qty ?? null,
        inSheet: Boolean(row),
        cost: v.cost ?? row?.cost ?? null,
        price: v.price,
        isBundle: Boolean(v.components),
        adminUrl: adminProductUrl(v.productId),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadDashboard() {
  const [catalog, orders, manualNeeds, purchasesResult] = await Promise.all([
    getCatalog(),
    getOpenOrders(),
    listManualNeeds(),
    listPurchases().then(
      (list) => ({ list, error: null as string | null }),
      (e: unknown) => ({ list: [], error: e instanceof Error ? e.message : String(e) }),
    ),
  ]);
  const { status: sheet, matches } = await loadSheet(catalog);
  const sheetMap = sheet.ok ? matches : null;
  const { items: toBuy, unmapped } = buildToBuy(orders, catalog, sheetMap, manualNeeds);
  const confirmations = buildConfirmations(orders);
  return {
    generatedAt: new Date().toISOString(),
    sheet,
    sentTag: config.confirmation.sentTag,
    toBuy,
    unmappedBundles: unmapped,
    confirmations,
    settlements: { ...buildSettlements(purchasesResult.list), error: purchasesResult.error },
    openOrders: orders.filter((o) => o.fulfillmentStatus !== "FULFILLED").length,
  };
}

export async function loadProducts() {
  const catalog = await getCatalog();
  const { status: sheet, matches } = await loadSheet(catalog);
  return { sheet, products: buildProductRows(catalog, sheet.ok ? matches : null) };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;
export type ProductsData = Awaited<ReturnType<typeof loadProducts>>;
