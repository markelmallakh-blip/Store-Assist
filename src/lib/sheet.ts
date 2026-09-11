import { JWT } from "google-auth-library";
import { config, sheetEnabled } from "@/lib/config";
import type { SheetRow, Variant } from "@/lib/types";

/**
 * The "actual inventory" Google Sheet.
 *
 * Inventory tab: one row per product. Column headers are matched by name (configurable in .env):
 *   Variant ID | SKU | Product | Actual Qty | Cost | Updated At
 * Rows are matched to Shopify by Variant ID, then SKU (when unique), then exact product name.
 *
 * Movements tab: append-only log of every change the dashboard makes (orders, purchases).
 */

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const API = "https://sheets.googleapis.com/v4/spreadsheets";

let client: JWT | null = null;

function credentials() {
  const raw = config.sheet.serviceAccountJson.trim();
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(json) as { client_email: string; private_key: string };
}

export function serviceAccountEmail(): string | null {
  try {
    return sheetEnabled() ? credentials().client_email : null;
  } catch {
    return null;
  }
}

async function authHeader() {
  if (!client) {
    const c = credentials();
    client = new JWT({ email: c.client_email, key: c.private_key, scopes: SCOPES });
  }
  const { token } = await client.getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

async function sheetsFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/${config.sheet.id}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(await authHeader()), ...(init.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

function colLetter(index: number) {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export type InventorySheet = {
  headers: string[];
  col: { variantId: number; sku: number; name: number; qty: number; cost: number; updatedAt: number };
  rows: SheetRow[];
};

let tabsChecked = false;

async function ensureTabs() {
  if (tabsChecked) return;
  const meta = await sheetsFetch<{ sheets: { properties: { title: string } }[] }>("?fields=sheets.properties.title");
  const titles = meta.sheets.map((s) => s.properties.title);
  const requests: unknown[] = [];
  if (!titles.includes(config.sheet.inventoryTab)) requests.push({ addSheet: { properties: { title: config.sheet.inventoryTab } } });
  if (!titles.includes(config.sheet.logTab)) requests.push({ addSheet: { properties: { title: config.sheet.logTab } } });
  if (requests.length) await sheetsFetch(":batchUpdate", { method: "POST", body: JSON.stringify({ requests }) });

  if (!titles.includes(config.sheet.inventoryTab)) {
    const c = config.sheet.columns;
    await writeRange(`${q(config.sheet.inventoryTab)}!A1`, [[c.variantId, c.sku, c.name, c.qty, c.cost, c.updatedAt]]);
  }
  if (!titles.includes(config.sheet.logTab)) {
    await writeRange(`${q(config.sheet.logTab)}!A1`, [["Timestamp", "Type", "Reference", "Variant ID", "SKU", "Product", "Change", "Qty After", "Note"]]);
  }
  tabsChecked = true;
}

async function writeRange(range: string, values: unknown[][]) {
  await sheetsFetch(`/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}

export async function readInventory(): Promise<InventorySheet> {
  await ensureTabs();
  const data = await sheetsFetch<{ values?: string[][] }>(
    `/values/${encodeURIComponent(q(config.sheet.inventoryTab))}?valueRenderOption=UNFORMATTED_VALUE`,
  );
  const values = data.values ?? [];
  const headers = (values[0] ?? []).map((h) => String(h));
  const find = (name: string) => headers.findIndex((h) => norm(h) === norm(name));
  const c = config.sheet.columns;
  const col = {
    variantId: find(c.variantId),
    sku: find(c.sku),
    name: find(c.name),
    qty: find(c.qty),
    cost: find(c.cost),
    updatedAt: find(c.updatedAt),
  };
  if (col.qty < 0) {
    throw new Error(`The "${config.sheet.inventoryTab}" tab needs a "${c.qty}" column header (set SHEET_COL_QTY to your header name).`);
  }
  const rows: SheetRow[] = values.slice(1).map((r, i) => {
    const cell = (idx: number) => (idx >= 0 ? r[idx] : undefined);
    const vid = cell(col.variantId);
    return {
      row: i + 2,
      variantId: vid ? String(vid).trim() || null : null,
      sku: cell(col.sku) !== undefined && cell(col.sku) !== "" ? String(cell(col.sku)).trim() : null,
      name: cell(col.name) ? String(cell(col.name)).trim() : null,
      qty: num(cell(col.qty)),
      cost: num(cell(col.cost)),
    };
  });
  return { headers, col, rows };
}

/**
 * Map each Shopify variant to its sheet row.
 * Variant ID wins; SKU is used only when exactly one variant in the catalog has that SKU
 * (multipacks often share the single's SKU); finally an exact product-name match.
 */
export function matchRows(sheet: InventorySheet, variants: Variant[]) {
  const byVid = new Map<string, SheetRow>();
  const bySku = new Map<string, SheetRow>();
  const byName = new Map<string, SheetRow>();
  for (const r of sheet.rows) {
    if (r.variantId) byVid.set(r.variantId.replace(/^gid:\/\/shopify\/ProductVariant\//, ""), r);
    if (r.sku) bySku.set(r.sku, r);
    if (r.name) byName.set(norm(r.name), r);
  }
  const skuCount = new Map<string, number>();
  const nameCount = new Map<string, number>();
  for (const v of variants) {
    if (v.components) continue;
    if (v.sku) skuCount.set(v.sku, (skuCount.get(v.sku) ?? 0) + 1);
    nameCount.set(norm(v.name), (nameCount.get(norm(v.name)) ?? 0) + 1);
  }

  const out = new Map<string, SheetRow>();
  const taken = new Set<number>();
  // Exact Variant ID matches first, so a fuzzy match can never steal a row that belongs to another variant.
  for (const v of variants) {
    const row = byVid.get(v.id.split("/").pop()!);
    if (row) {
      out.set(v.id, row);
      taken.add(row.row);
    }
  }
  for (const v of variants) {
    if (out.has(v.id)) continue;
    // SKU / name only when unambiguous (duplicated products and multipacks share them).
    const row =
      (v.sku && skuCount.get(v.sku) === 1 ? bySku.get(v.sku) : undefined) ??
      (nameCount.get(norm(v.name)) === 1 ? byName.get(norm(v.name)) : undefined);
    if (row && !taken.has(row.row)) {
      out.set(v.id, row);
      taken.add(row.row);
    }
  }
  return out;
}

export type SheetChange = {
  variant: Variant;
  delta: number;
  /** Replace the cost cell (purchases). */
  cost?: number | null;
};

export type LogEntry = { type: string; reference: string; note?: string };

/**
 * Apply quantity deltas to the sheet and log them.
 * Items not in the sheet yet get a new row (so nothing is lost), starting from the delta.
 */
export async function applySheetChanges(changes: SheetChange[], log: LogEntry) {
  const real = changes.filter((c) => c.delta !== 0 || c.cost != null);
  if (!real.length) return [];
  const sheet = await readInventory();
  const matches = matchRows(sheet, real.map((c) => c.variant));
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const updates: { range: string; values: unknown[][] }[] = [];
  const appends: unknown[][] = [];
  const logRows: unknown[][] = [];
  const results: { variantId: string; before: number | null; after: number }[] = [];
  const tab = q(config.sheet.inventoryTab);
  const width = Math.max(sheet.headers.length, 6);

  // Combine duplicate variants so two changes to one row don't overwrite each other.
  const merged = new Map<string, SheetChange>();
  for (const c of real) {
    const prev = merged.get(c.variant.id);
    merged.set(c.variant.id, prev ? { ...prev, delta: prev.delta + c.delta, cost: c.cost ?? prev.cost } : { ...c });
  }

  for (const c of merged.values()) {
    const row = matches.get(c.variant.id);
    const before = row?.qty ?? null;
    const after = (before ?? 0) + c.delta;
    results.push({ variantId: c.variant.id, before, after });
    if (row) {
      updates.push({ range: `${tab}!${colLetter(sheet.col.qty)}${row.row}`, values: [[after]] });
      if (c.cost != null && sheet.col.cost >= 0) updates.push({ range: `${tab}!${colLetter(sheet.col.cost)}${row.row}`, values: [[c.cost]] });
      if (sheet.col.updatedAt >= 0) updates.push({ range: `${tab}!${colLetter(sheet.col.updatedAt)}${row.row}`, values: [[now]] });
      // Backfill the Variant ID so future matches are exact.
      if (sheet.col.variantId >= 0 && !row.variantId) {
        updates.push({ range: `${tab}!${colLetter(sheet.col.variantId)}${row.row}`, values: [[c.variant.id.split("/").pop()]] });
      }
    } else {
      const newRow: unknown[] = new Array(width).fill("");
      const set = (idx: number, v: unknown) => {
        if (idx >= 0) newRow[idx] = v;
      };
      set(sheet.col.variantId, c.variant.id.split("/").pop());
      set(sheet.col.sku, c.variant.sku ?? "");
      set(sheet.col.name, c.variant.name);
      set(sheet.col.qty, after);
      set(sheet.col.cost, c.cost ?? c.variant.cost ?? "");
      set(sheet.col.updatedAt, now);
      appends.push(newRow);
    }
    if (c.delta !== 0) {
      logRows.push([now, log.type, log.reference, c.variant.id.split("/").pop(), c.variant.sku ?? "", c.variant.name, c.delta, after, (row ? "" : "new row; ") + (log.note ?? "")]);
    }
  }

  if (updates.length) {
    await sheetsFetch("/values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: updates }),
    });
  }
  if (appends.length) await appendRows(config.sheet.inventoryTab, appends);
  if (logRows.length) await appendRows(config.sheet.logTab, logRows);
  return results;
}

async function appendRows(tabName: string, rows: unknown[][]) {
  await sheetsFetch(`/values/${encodeURIComponent(q(tabName))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: rows }),
  });
}

/** Add rows for catalog items that aren't in the sheet yet (Actual Qty left blank for you to count). */
export async function addMissingRows(variants: Variant[]) {
  const sheet = await readInventory();
  const matches = matchRows(sheet, variants);
  const width = Math.max(sheet.headers.length, 6);
  const rows = variants
    .filter((v) => !matches.has(v.id))
    .map((v) => {
      const r: unknown[] = new Array(width).fill("");
      const set = (idx: number, val: unknown) => {
        if (idx >= 0) r[idx] = val;
      };
      set(sheet.col.variantId, v.id.split("/").pop());
      set(sheet.col.sku, v.sku ?? "");
      set(sheet.col.name, v.name);
      set(sheet.col.cost, v.cost ?? "");
      return r;
    });
  if (rows.length) await appendRows(config.sheet.inventoryTab, rows);
  return rows.length;
}
