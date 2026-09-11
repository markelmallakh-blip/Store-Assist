import { config, sheetEnabled } from "@/lib/config";
import { expandVariant } from "@/lib/bundles";
import { applySheetChanges, type SheetChange } from "@/lib/sheet";
import { byId, getCatalog } from "@/lib/shopify/catalog";
import { adjustInventory, setMetafields } from "@/lib/shopify/mutations";
import { getOpenOrders, getOrderForSync } from "@/lib/shopify/orders";

/**
 * Keeps the sheet (and optionally Shopify single-item stock for bundles) in line with an order.
 *
 * Each order remembers what was already applied in its `store_assist.applied` metafield.
 * Every sync computes what the order *should* have taken (current quantities, 0 if cancelled),
 * and applies only the difference. So it is safe to run any number of times: on create, edit,
 * refund, cancel, or from the backfill/cron.
 */

type Applied = { sheet?: Record<string, number>; shopify?: Record<string, number> };

export type SyncResult = {
  order: string;
  status: "applied" | "unchanged" | "skipped";
  reason?: string;
  sheetChanges?: number;
  shopifyChanges?: number;
};

function parseApplied(value: string | null): Applied | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Applied;
  } catch {
    return null;
  }
}

function diff(desired: Map<string, number>, applied: Record<string, number> = {}) {
  const keys = new Set([...desired.keys(), ...Object.keys(applied)]);
  const out: { variantId: string; delta: number }[] = [];
  for (const k of keys) {
    const d = (desired.get(k) ?? 0) - (applied[k] ?? 0);
    if (d !== 0) out.push({ variantId: k, delta: d });
  }
  return out;
}

export async function syncOrder(orderId: string, opts: { backfill?: boolean } = {}): Promise<SyncResult> {
  const order = await getOrderForSync(orderId);
  if (!order) return { order: orderId, status: "skipped", reason: "order not found" };

  const previous = parseApplied(order.applied);
  if (!previous) {
    if (opts.backfill && order.fulfillmentStatus === "FULFILLED") {
      return { order: order.name, status: "skipped", reason: "already fulfilled before the sheet was connected" };
    }
    const from = config.sheetSyncFrom ? Date.parse(config.sheetSyncFrom) : NaN;
    if (!opts.backfill && Number.isFinite(from) && Date.parse(order.createdAt) < from && order.fulfillmentStatus === "FULFILLED") {
      return { order: order.name, status: "skipped", reason: "created before SHEET_SYNC_FROM" };
    }
  }

  const catalog = byId(await getCatalog());
  const desiredSheet = new Map<string, number>();
  const desiredShopify = new Map<string, number>();

  if (!order.cancelledAt) {
    for (const line of order.lines) {
      if (!line.variantId || line.currentQuantity <= 0) continue;
      for (const e of expandVariant(line.variantId, line.currentQuantity, catalog)) {
        if (!catalog.has(e.variantId)) continue;
        desiredSheet.set(e.variantId, (desiredSheet.get(e.variantId) ?? 0) - e.qty);
        if (e.viaBundle) desiredShopify.set(e.variantId, (desiredShopify.get(e.variantId) ?? 0) - e.qty);
      }
    }
  }

  const next: Applied = { ...(previous ?? {}) };
  let sheetChanges = 0;
  let shopifyChanges = 0;
  const type = order.cancelledAt ? "order cancelled" : previous ? "order changed" : "order";

  if (sheetEnabled()) {
    const changes: SheetChange[] = diff(desiredSheet, previous?.sheet).map((d) => ({
      variant: catalog.get(d.variantId)!,
      delta: d.delta,
    })).filter((c) => c.variant);
    if (changes.length) {
      await applySheetChanges(changes, { type, reference: order.name });
      sheetChanges = changes.length;
    }
    next.sheet = Object.fromEntries(desiredSheet);
  }

  if (config.syncBundlesToShopify) {
    const changes = diff(desiredShopify, previous?.shopify)
      .map((d) => ({ inventoryItemId: catalog.get(d.variantId)?.inventoryItemId ?? "", delta: d.delta }))
      .filter((c) => c.inventoryItemId);
    if (changes.length) {
      await adjustInventory(changes, "correction", order.id);
      shopifyChanges = changes.length;
    }
    next.shopify = Object.fromEntries(desiredShopify);
  }

  if (!sheetChanges && !shopifyChanges && previous) {
    return { order: order.name, status: "unchanged" };
  }
  if (next.sheet || next.shopify) {
    await setMetafields([{ ownerId: order.id, namespace: "store_assist", key: "applied", type: "json", value: JSON.stringify(next) }]);
  }
  return {
    order: order.name,
    status: sheetChanges || shopifyChanges ? "applied" : "unchanged",
    sheetChanges,
    shopifyChanges,
  };
}

/** One-time (and repeatable) catch-up: apply every open, not-yet-fulfilled order. */
export async function syncOpenOrders() {
  const orders = await getOpenOrders();
  const results: SyncResult[] = [];
  // Sequential on purpose: each sync reads then writes the sheet.
  for (const o of orders) {
    if (o.fulfillmentStatus === "FULFILLED") continue;
    try {
      results.push(await syncOrder(o.id, { backfill: true }));
    } catch (e) {
      results.push({ order: o.name, status: "skipped", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
