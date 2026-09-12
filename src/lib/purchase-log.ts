import { randomUUID } from "node:crypto";
import { assertNoUserErrors, gql, ShopifyError } from "@/lib/shopify/client";

/**
 * Purchase history, stored in the Shopify store itself as metaobjects of type "store_assist_purchase"
 * (visible in Shopify admin → Content → Metaobjects). Receipt photos go to Shopify Files.
 * Everyone using the dashboard (locally or on the live site) sees the same history.
 *
 * A purchase paid by a team member (not the company) is money Cupcairo owes them until it's settled.
 */

export type PurchaseItem = { variantId: string; name: string; qty: number; unitCost: number | null };

export type PurchaseRecord = {
  id: string;
  /** YYYY-MM-DD (Cairo) */
  purchasedOn: string;
  paidBy: string;
  total: number;
  items: PurchaseItem[];
  note: string;
  receiptUrl: string | null;
  receiptFileId: string | null;
  /** YYYY-MM-DD when Cupcairo paid the person back; null = still owed (or paid by the company). */
  settledOn: string | null;
  updatedAt: string;
};

const TYPE = "store_assist_purchase";

export const companyPayer = () => process.env.COMPANY_PAYER || "Cupcairo";
export const teamMembers = () =>
  (process.env.TEAM_MEMBERS || "Mark,Michael,Andrew")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
export const payers = () => [companyPayer(), ...teamMembers()];

/** Today's date in Cairo as YYYY-MM-DD. */
export const todayCairo = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Friendlier message when the app hasn't been granted the new permissions yet. */
function explain(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/access denied|ACCESS_DENIED|required access|scope/i.test(msg)) {
    throw new ShopifyError(
      "Store Assist needs permission to save purchase history. Approve the app's new permissions in Shopify admin → Apps → Store Assist.",
    );
  }
  throw e instanceof Error ? e : new Error(msg);
}

// ---------------------------------------------------------------------------
// Local file store for fixture/preview mode
// ---------------------------------------------------------------------------

const fixtureFile = () => (process.env.SHOPIFY_FIXTURES_DIR ? `${process.env.SHOPIFY_FIXTURES_DIR}/purchases.local.json` : null);

async function readLocal(): Promise<PurchaseRecord[]> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(fixtureFile()!, "utf8").catch(() => "[]")) as PurchaseRecord[];
}
async function writeLocal(list: PurchaseRecord[]) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(fixtureFile()!, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------------------
// Shopify storage
// ---------------------------------------------------------------------------

let definitionReady = false;

async function ensureDefinition() {
  if (definitionReady) return;
  const data: { metaobjectDefinitionByType: { id: string } | null } = await gql(
    `query PurchaseDefinition { metaobjectDefinitionByType(type: "${TYPE}") { id } }`,
  );
  if (!data.metaobjectDefinitionByType) {
    const res: { metaobjectDefinitionCreate: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
      `mutation CreatePurchaseDefinition($definition: MetaobjectDefinitionCreateInput!) {
        metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id } userErrors { field message code } }
      }`,
      {
        definition: {
          name: "Store Assist purchase",
          description: "Stock bought for the store, recorded from Store Assist.",
          type: TYPE,
          displayNameKey: "title",
          access: { admin: "MERCHANT_READ_WRITE", storefront: "NONE" },
          fieldDefinitions: [
            { key: "title", name: "Title", type: "single_line_text_field" },
            { key: "purchased_on", name: "Purchased on", type: "date", required: true },
            { key: "paid_by", name: "Paid by", type: "single_line_text_field", required: true },
            { key: "total", name: "Total paid (EGP)", type: "number_decimal" },
            { key: "items", name: "Items", type: "json", required: true },
            { key: "note", name: "Note", type: "multi_line_text_field" },
            { key: "receipt", name: "Receipt photo", type: "file_reference" },
            { key: "settled_on", name: "Settled on", type: "date" },
          ],
        },
      },
    );
    assertNoUserErrors("metaobjectDefinitionCreate", res.metaobjectDefinitionCreate.userErrors);
  }
  definitionReady = true;
}

type RawPurchase = {
  id: string;
  updatedAt: string;
  fields: { key: string; value: string | null }[];
  receipt: { reference: { id?: string; image: { url: string } | null } | null } | null;
};

function toRecord(n: RawPurchase): PurchaseRecord {
  const f = Object.fromEntries(n.fields.map((x) => [x.key, x.value ?? ""]));
  let items: PurchaseItem[] = [];
  try {
    items = JSON.parse(f.items || "[]");
  } catch {
    items = [];
  }
  return {
    id: n.id,
    purchasedOn: f.purchased_on,
    paidBy: f.paid_by,
    total: Number(f.total || 0),
    items,
    note: f.note || "",
    receiptUrl: n.receipt?.reference?.image?.url ?? null,
    receiptFileId: n.receipt?.reference?.id ?? null,
    settledOn: f.settled_on || null,
    updatedAt: n.updatedAt,
  };
}

/** Every purchase ever recorded, newest first. */
export async function listPurchases(): Promise<PurchaseRecord[]> {
  if (fixtureFile()) return sortNewest(await readLocal());
  const out: PurchaseRecord[] = [];
  let cursor: string | null = null;
  try {
    await ensureDefinition();
    do {
      const data: { metaobjects: { nodes: RawPurchase[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await gql(
        `query Purchases($cursor: String) {
          metaobjects(type: "${TYPE}", first: 250, after: $cursor, sortKey: "updated_at", reverse: true) {
            nodes {
              id updatedAt
              fields { key value }
              receipt: field(key: "receipt") { reference { ... on MediaImage { id image { url(transform: { maxWidth: 1400 }) } } } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { cursor },
      );
      out.push(...data.metaobjects.nodes.map(toRecord));
      cursor = data.metaobjects.pageInfo.hasNextPage ? data.metaobjects.pageInfo.endCursor : null;
    } while (cursor);
  } catch (e) {
    explain(e);
  }
  return sortNewest(out);
}

const sortNewest = (list: PurchaseRecord[]) =>
  [...list].sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn) || b.updatedAt.localeCompare(a.updatedAt));

/** Upload a JPEG receipt to Shopify Files; returns the file id. */
async function uploadReceipt(base64: string, label: string): Promise<string> {
  const bytes = Buffer.from(base64, "base64");
  const filename = `receipt-${label}-${randomUUID().slice(0, 8)}.jpg`;
  const staged: {
    stagedUploadsCreate: {
      stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[];
      userErrors: { field: string[] | null; message: string }[];
    };
  } = await gql(
    `mutation Staged($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }
    }`,
    { input: [{ resource: "IMAGE", filename, mimeType: "image/jpeg", httpMethod: "POST", fileSize: String(bytes.length) }] },
  );
  assertNoUserErrors("stagedUploadsCreate", staged.stagedUploadsCreate.userErrors);
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes], { type: "image/jpeg" }), filename);
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) throw new Error(`Receipt upload failed (${up.status})`);

  const created: { fileCreate: { files: { id: string }[]; userErrors: { field: string[] | null; message: string }[] } } = await gql(
    `mutation ReceiptFile($files: [FileCreateInput!]!) {
      fileCreate(files: $files) { files { id fileStatus } userErrors { field message code } }
    }`,
    { files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", alt: `Receipt ${label}` }] },
  );
  assertNoUserErrors("fileCreate", created.fileCreate.userErrors);
  return created.fileCreate.files[0].id;
}

const egp = (n: number) => new Intl.NumberFormat("en-EG", { maximumFractionDigits: 2 }).format(n);

export type NewPurchase = {
  purchasedOn: string;
  paidBy: string;
  total: number;
  items: PurchaseItem[];
  note: string;
  receipt: { data: string } | null;
};

/** Validate the purchase header before anything is written. */
export function validateNewPurchase(p: NewPurchase) {
  if (!payers().includes(p.paidBy)) throw new Error(`Choose who paid (${payers().join(", ")}).`);
  if (!isDate(p.purchasedOn) || p.purchasedOn > todayCairo()) throw new Error("Purchase date can't be in the future.");
  if (!(p.total >= 0)) throw new Error("Total paid must be a number.");
  if (p.paidBy !== companyPayer() && !(p.total > 0)) throw new Error(`Enter the total ${p.paidBy} paid, so it can be settled later.`);
}

export async function recordPurchase(p: NewPurchase): Promise<{ id: string; receiptSaved: boolean; receiptError?: string }> {
  const title = `${p.purchasedOn} · ${p.paidBy} · ${egp(p.total)} EGP`;

  if (fixtureFile()) {
    const list = await readLocal();
    const rec: PurchaseRecord = {
      id: `local-${randomUUID()}`,
      purchasedOn: p.purchasedOn,
      paidBy: p.paidBy,
      total: p.total,
      items: p.items,
      note: p.note,
      receiptUrl: p.receipt ? `data:image/jpeg;base64,${p.receipt.data}` : null,
      receiptFileId: null,
      settledOn: null,
      updatedAt: new Date().toISOString(),
    };
    await writeLocal([rec, ...list]);
    return { id: rec.id, receiptSaved: Boolean(p.receipt) };
  }

  try {
    await ensureDefinition();
    let receiptId: string | null = null;
    let receiptError: string | undefined;
    if (p.receipt) {
      try {
        receiptId = await uploadReceipt(p.receipt.data, p.purchasedOn);
      } catch (e) {
        receiptError = e instanceof Error ? e.message : String(e);
      }
    }
    const fields = [
      { key: "title", value: title },
      { key: "purchased_on", value: p.purchasedOn },
      { key: "paid_by", value: p.paidBy },
      { key: "total", value: String(p.total) },
      { key: "items", value: JSON.stringify(p.items) },
      { key: "note", value: p.note },
      ...(receiptId ? [{ key: "receipt", value: receiptId }] : []),
    ];
    const res: { metaobjectCreate: { metaobject: { id: string } | null; userErrors: { field: string[] | null; message: string }[] } } =
      await gql(
        `mutation CreatePurchase($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) { metaobject { id } userErrors { field message code } }
        }`,
        { metaobject: { type: TYPE, handle: `purchase-${p.purchasedOn}-${randomUUID().slice(0, 8)}`, fields } },
      );
    assertNoUserErrors("metaobjectCreate", res.metaobjectCreate.userErrors);
    return { id: res.metaobjectCreate.metaobject!.id, receiptSaved: Boolean(receiptId), receiptError };
  } catch (e) {
    explain(e);
  }
}

/**
 * Mark purchases as paid back. The date must be between the (latest) purchase date and today.
 * Pass settledOn = null to undo.
 */
export async function settlePurchases(ids: string[], settledOn: string | null) {
  if (!ids.length) throw new Error("Nothing to settle");
  const all = await listPurchases();
  const chosen = ids.map((id) => all.find((p) => p.id === id));
  if (chosen.some((p) => !p)) throw new Error("Purchase not found. Refresh and try again.");
  const list = chosen as PurchaseRecord[];
  if (list.some((p) => p.paidBy === companyPayer())) throw new Error(`Purchases paid by ${companyPayer()} don't need settling.`);

  if (settledOn !== null) {
    const earliest = list.reduce((m, p) => (p.purchasedOn > m ? p.purchasedOn : m), "0000-00-00");
    if (!isDate(settledOn)) throw new Error("Choose the settlement date.");
    if (settledOn < earliest) throw new Error(`Settlement date can't be before the purchase date (${earliest}).`);
    if (settledOn > todayCairo()) throw new Error("Settlement date can't be in the future.");
  }

  if (fixtureFile()) {
    const local = await readLocal();
    await writeLocal(local.map((p) => (ids.includes(p.id) ? { ...p, settledOn, updatedAt: new Date().toISOString() } : p)));
    return { settled: ids.length };
  }

  try {
    for (const id of ids) {
      const res: { metaobjectUpdate: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
        `mutation UpdatePurchase($id: ID!, $metaobject: MetaobjectUpdateInput!) {
          metaobjectUpdate(id: $id, metaobject: $metaobject) { metaobject { id } userErrors { field message code } }
        }`,
        { id, metaobject: { fields: [{ key: "settled_on", value: settledOn ?? "" }] } },
      );
      assertNoUserErrors("metaobjectUpdate", res.metaobjectUpdate.userErrors);
    }
  } catch (e) {
    explain(e);
  }
  return { settled: ids.length };
}

export type Settlement = { person: string; owed: number; purchases: PurchaseRecord[] };

/** Money Cupcairo owes each team member (newest purchases first), plus everything already settled. */
export function buildSettlements(purchases: PurchaseRecord[]) {
  const company = companyPayer();
  const people = new Map<string, Settlement>();
  for (const name of teamMembers()) people.set(name, { person: name, owed: 0, purchases: [] });
  for (const p of purchases) {
    if (p.paidBy === company || p.settledOn) continue;
    const s = people.get(p.paidBy) ?? { person: p.paidBy, owed: 0, purchases: [] };
    s.owed += p.total;
    s.purchases.push(p);
    people.set(p.paidBy, s);
  }
  for (const s of people.values()) s.purchases.sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn));
  return {
    open: [...people.values()].filter((s) => s.purchases.length).sort((a, b) => b.owed - a.owed),
    settled: purchases
      .filter((p) => p.paidBy !== company && p.settledOn)
      .sort((a, b) => b.settledOn!.localeCompare(a.settledOn!) || b.purchasedOn.localeCompare(a.purchasedOn)),
    today: todayCairo(),
  };
}

export type PurchasePatch = {
  purchasedOn: string;
  paidBy: string;
  total: number;
  note: string;
  items: PurchaseItem[];
  settledOn: string | null;
};

/** Edit a purchase. Settlement rules still apply (date between purchase date and today). */
export async function updatePurchase(id: string, patch: PurchasePatch) {
  validateNewPurchase({ ...patch, receipt: null });
  if (!patch.items.length) throw new Error("A purchase needs at least one item. Delete it instead.");
  const settledOn = patch.paidBy === companyPayer() ? null : patch.settledOn;
  if (settledOn !== null) {
    if (!isDate(settledOn)) throw new Error("Choose the settlement date.");
    if (settledOn < patch.purchasedOn) throw new Error(`Settlement date can't be before the purchase date (${patch.purchasedOn}).`);
    if (settledOn > todayCairo()) throw new Error("Settlement date can't be in the future.");
  }
  const title = `${patch.purchasedOn} · ${patch.paidBy} · ${egp(patch.total)} EGP`;

  if (fixtureFile()) {
    const list = await readLocal();
    if (!list.some((p) => p.id === id)) throw new Error("Purchase not found. Refresh and try again.");
    await writeLocal(list.map((p) => (p.id === id ? { ...p, ...patch, settledOn, updatedAt: new Date().toISOString() } : p)));
    return;
  }
  try {
    const res: { metaobjectUpdate: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
      `mutation UpdatePurchase($id: ID!, $metaobject: MetaobjectUpdateInput!) {
        metaobjectUpdate(id: $id, metaobject: $metaobject) { metaobject { id } userErrors { field message code } }
      }`,
      {
        id,
        metaobject: {
          fields: [
            { key: "title", value: title },
            { key: "purchased_on", value: patch.purchasedOn },
            { key: "paid_by", value: patch.paidBy },
            { key: "total", value: String(patch.total) },
            { key: "items", value: JSON.stringify(patch.items) },
            { key: "note", value: patch.note },
            { key: "settled_on", value: settledOn ?? "" },
          ],
        },
      },
    );
    assertNoUserErrors("metaobjectUpdate", res.metaobjectUpdate.userErrors);
  } catch (e) {
    explain(e);
  }
}

/** Delete a purchase record (and its receipt photo from Shopify Files). */
export async function deletePurchase(record: PurchaseRecord) {
  if (fixtureFile()) {
    await writeLocal((await readLocal()).filter((p) => p.id !== record.id));
    return;
  }
  try {
    const res: { metaobjectDelete: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
      `mutation DeletePurchase($id: ID!) { metaobjectDelete(id: $id) { deletedId userErrors { field message code } } }`,
      { id: record.id },
    );
    assertNoUserErrors("metaobjectDelete", res.metaobjectDelete.userErrors);
    if (record.receiptFileId) {
      await gql(
        `mutation DeleteReceipt($fileIds: [ID!]!) { fileDelete(fileIds: $fileIds) { deletedFileIds userErrors { field message code } } }`,
        { fileIds: [record.receiptFileId] },
      ).catch((e) => console.error("receipt file delete failed", e));
    }
  } catch (e) {
    explain(e);
  }
}
