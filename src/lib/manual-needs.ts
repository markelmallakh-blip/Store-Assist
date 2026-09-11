import { randomUUID } from "node:crypto";
import { gql } from "@/lib/shopify/client";
import { setMetafields } from "@/lib/shopify/mutations";

/**
 * Items someone added to the To Buy list by hand ("we're low on X, buy 10").
 * Stored as one JSON metafield on the shop (store_assist.manual_needs), so every admin sees the same list.
 * Recording a purchase of the item reduces / clears its manual need.
 */
export type ManualNeed = { id: string; variantId: string; qty: number; note: string; addedAt: string };

const fixtureFile = () => (process.env.SHOPIFY_FIXTURES_DIR ? `${process.env.SHOPIFY_FIXTURES_DIR}/manual-needs.local.json` : null);

async function load(): Promise<{ shopId: string; list: ManualNeed[] }> {
  const file = fixtureFile();
  if (file) {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(file, "utf8").catch(() => "[]");
    return { shopId: "fixture", list: JSON.parse(raw) as ManualNeed[] };
  }
  const data: { shop: { id: string; manualNeeds: { value: string } | null } } = await gql(
    `query ManualNeeds { shop { id manualNeeds: metafield(namespace: "store_assist", key: "manual_needs") { value } } }`,
  );
  let list: ManualNeed[] = [];
  try {
    list = data.shop.manualNeeds ? (JSON.parse(data.shop.manualNeeds.value) as ManualNeed[]) : [];
  } catch {
    list = [];
  }
  return { shopId: data.shop.id, list: Array.isArray(list) ? list : [] };
}

async function save(shopId: string, list: ManualNeed[]) {
  const file = fixtureFile();
  if (file) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify(list, null, 2));
    return;
  }
  await setMetafields([{ ownerId: shopId, namespace: "store_assist", key: "manual_needs", type: "json", value: JSON.stringify(list) }]);
}

export async function listManualNeeds() {
  return (await load()).list;
}

export async function addManualNeed(input: { variantId: string; qty: number; note: string }) {
  const qty = Math.round(input.qty);
  if (!input.variantId.startsWith("gid://shopify/ProductVariant/") || !(qty > 0)) throw new Error("Pick a product and a quantity");
  const { shopId, list } = await load();
  list.push({ id: randomUUID(), variantId: input.variantId, qty, note: input.note.trim().slice(0, 200), addedAt: new Date().toISOString() });
  await save(shopId, list);
  return list;
}

export async function removeManualNeed(id: string) {
  const { shopId, list } = await load();
  const next = list.filter((n) => n.id !== id);
  await save(shopId, next);
  return next;
}

/** After a purchase: take the bought quantities off the oldest manual needs first. */
export async function consumeManualNeeds(bought: { variantId: string; qty: number }[]) {
  const { shopId, list } = await load();
  if (!list.length) return;
  const left = new Map<string, number>();
  for (const b of bought) left.set(b.variantId, (left.get(b.variantId) ?? 0) + b.qty);
  let changed = false;
  const next: ManualNeed[] = [];
  for (const n of [...list].sort((a, b) => a.addedAt.localeCompare(b.addedAt))) {
    const avail = left.get(n.variantId) ?? 0;
    if (avail <= 0) {
      next.push(n);
      continue;
    }
    changed = true;
    const used = Math.min(avail, n.qty);
    left.set(n.variantId, avail - used);
    if (n.qty - used > 0) next.push({ ...n, qty: n.qty - used });
  }
  if (changed) await save(shopId, next);
}
