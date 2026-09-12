import { handle } from "@/lib/api";
import { adjustStockForPurchase } from "@/lib/purchase";
import {
  companyPayer,
  deletePurchase,
  listPurchases,
  payers,
  settlePurchases,
  todayCairo,
  updatePurchase,
  type PurchasePatch,
} from "@/lib/purchase-log";

/** Purchase log (all purchases, newest first) + the list of people who can pay. */
export const GET = handle(async () => {
  const purchases = await listPurchases();
  return { purchases, payers: payers(), company: companyPayer(), today: todayCairo() };
});

type Body =
  | { action?: "settle"; ids: string[]; settledOn: string | null }
  | { action: "update"; id: string; patch: PurchasePatch; adjustStock: boolean }
  | { action: "delete"; id: string; removeStock: boolean };

/** Settle, edit or delete purchases. Edits/deletes can also correct the stock the purchase added. */
export const POST = handle(async (request: Request) => {
  const body = (await request.json()) as Body;

  if (body.action === "update" || body.action === "delete") {
    const existing = (await listPurchases()).find((p) => p.id === body.id);
    if (!existing) throw new Error("Purchase not found. Refresh and try again.");

    if (body.action === "delete") {
      let stock = null;
      if (body.removeStock) {
        stock = await adjustStockForPurchase(existing.items.map((i) => ({ variantId: i.variantId, delta: -i.qty })), "purchase deleted");
      }
      await deletePurchase(existing);
      return { ok: true, stock };
    }

    const patch: PurchasePatch = {
      purchasedOn: body.patch.purchasedOn,
      paidBy: body.patch.paidBy,
      total: Math.round(Number(body.patch.total) * 100) / 100,
      note: String(body.patch.note ?? "").slice(0, 500),
      settledOn: body.patch.settledOn || null,
      items: (body.patch.items ?? [])
        .map((i) => ({ variantId: i.variantId, name: i.name, qty: Math.round(Number(i.qty)), unitCost: i.unitCost == null ? null : Number(i.unitCost) }))
        .filter((i) => i.variantId && i.qty > 0),
    };
    let stock = null;
    if (body.adjustStock) {
      const before = new Map(existing.items.map((i) => [i.variantId, i.qty]));
      const after = new Map(patch.items.map((i) => [i.variantId, i.qty]));
      const ids = new Set([...before.keys(), ...after.keys()]);
      const deltas = [...ids].map((id) => ({ variantId: id, delta: (after.get(id) ?? 0) - (before.get(id) ?? 0) }));
      if (deltas.some((d) => d.delta !== 0)) {
        // Validate first so a bad edit doesn't move stock.
        await updatePurchase(body.id, patch);
        stock = await adjustStockForPurchase(deltas, "purchase edited");
        return { ok: true, stock };
      }
    }
    await updatePurchase(body.id, patch);
    return { ok: true, stock };
  }

  return settlePurchases(Array.isArray(body.ids) ? body.ids : [], body.settledOn ?? null);
});
