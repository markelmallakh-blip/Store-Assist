import { sheetEnabled } from "@/lib/config";
import { consumeManualNeeds } from "@/lib/manual-needs";
import { applySheetChanges } from "@/lib/sheet";
import { byId, getCatalog, invalidateCatalog } from "@/lib/shopify/catalog";
import { adjustInventory, setUnitCost } from "@/lib/shopify/mutations";

export type CommitLine = { variantId: string; qty: number; unitCost: number | null };

export type CommitResult = {
  variantId: string;
  name: string;
  qty: number;
  shopify: { ok: boolean; after?: number | null; error?: string };
  cost: { ok: boolean; skipped?: boolean; error?: string };
  sheet: { ok: boolean; skipped?: boolean; after?: number; error?: string };
};

/**
 * Record stock that was just bought: + qty in Shopify, cost per item updated,
 * + qty in the actual-inventory sheet with a "purchase" log entry.
 */
export async function commitPurchase(lines: CommitLine[], note: string) {
  const catalog = byId(await getCatalog());
  const clean = lines
    .map((l) => ({ ...l, qty: Math.round(l.qty), variant: catalog.get(l.variantId) }))
    .filter((l) => l.variant && l.qty > 0);

  const results: CommitResult[] = clean.map((l) => ({
    variantId: l.variantId,
    name: l.variant!.name,
    qty: l.qty,
    shopify: { ok: false },
    cost: { ok: false },
    sheet: { ok: false },
  }));
  if (!clean.length) return results;

  const reference = `purchase-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;

  // 1) Shopify inventory, one adjustment group for the whole purchase.
  try {
    const changes = await adjustInventory(
      clean.map((l) => ({ inventoryItemId: l.variant!.inventoryItemId, delta: l.qty })),
      "received",
      `gid://store-assist/Purchase/${reference}`,
    );
    for (const r of results) {
      const item = catalog.get(r.variantId)!.inventoryItemId;
      const change = changes.find((c) => c.item.id === item);
      r.shopify = { ok: true, after: change?.quantityAfterChange ?? null };
    }
  } catch (e) {
    for (const r of results) r.shopify = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 2) Cost per item.
  await Promise.all(
    clean.map(async (l, i) => {
      if (l.unitCost == null || !(l.unitCost > 0)) {
        results[i].cost = { ok: true, skipped: true };
        return;
      }
      try {
        await setUnitCost(l.variant!.inventoryItemId, l.unitCost);
        results[i].cost = { ok: true };
      } catch (e) {
        results[i].cost = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  // 3) Actual inventory sheet.
  if (!sheetEnabled()) {
    for (const r of results) r.sheet = { ok: true, skipped: true };
  } else {
    try {
      const applied = await applySheetChanges(
        clean.map((l) => ({ variant: l.variant!, delta: l.qty, cost: l.unitCost })),
        { type: "purchase", reference, note },
      );
      for (const r of results) {
        const a = applied.find((x) => x.variantId === r.variantId);
        r.sheet = { ok: true, after: a?.after };
      }
    } catch (e) {
      for (const r of results) r.sheet = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Bought items no longer need to stay on the manual To Buy list.
  const bought = results.filter((r) => r.shopify.ok || r.sheet.ok).map((r) => ({ variantId: r.variantId, qty: r.qty }));
  if (bought.length) await consumeManualNeeds(bought).catch((e) => console.error("manual needs update failed", e));

  invalidateCatalog();
  return results;
}

/**
 * Change stock after editing or deleting a purchase: positive delta adds, negative removes.
 * Updates Shopify inventory and the actual sheet (cost per item is left as it is).
 */
export async function adjustStockForPurchase(deltas: { variantId: string; delta: number }[], reason: string) {
  const catalog = byId(await getCatalog());
  const real = deltas
    .map((d) => ({ ...d, delta: Math.round(d.delta), variant: catalog.get(d.variantId) }))
    .filter((d) => d.variant && d.delta !== 0);
  const out = { shopify: true, sheet: sheetEnabled(), changed: real.length, error: undefined as string | undefined };
  if (!real.length) return out;
  const reference = `gid://store-assist/PurchaseEdit/${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  try {
    await adjustInventory(real.map((d) => ({ inventoryItemId: d.variant!.inventoryItemId, delta: d.delta })), "correction", reference);
  } catch (e) {
    out.shopify = false;
    out.error = e instanceof Error ? e.message : String(e);
  }
  if (sheetEnabled()) {
    try {
      await applySheetChanges(real.map((d) => ({ variant: d.variant!, delta: d.delta })), { type: reason, reference: reference.split("/").pop()! });
    } catch (e) {
      out.sheet = false;
      out.error = (out.error ? `${out.error}; ` : "") + (e instanceof Error ? e.message : String(e));
    }
  }
  invalidateCatalog();
  return out;
}
