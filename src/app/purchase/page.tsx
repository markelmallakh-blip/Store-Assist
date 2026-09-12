"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useRef, useState } from "react";
import type { CommitResult } from "@/lib/purchase";
import type { PurchaseRecord } from "@/lib/purchase-log";
import type { PurchaseReading } from "@/lib/receipt";
import { IconCamera, IconCheck, IconChevronDown, IconMinus, IconPlus, IconX } from "@/components/icons";
import { ProductPicker, type PickerItem } from "@/components/product-picker";
import { api, Badge, Button, Card, Empty, ErrorBox, Modal, money, PageHeader, Spinner, Thumb, todayInCairo, useApi, useToast } from "@/components/ui";

type CatalogItem = PickerItem & { vendor: string; cost: number | null; shopifyQty: number };

type Candidate = { variantId: string; name: string; image: string | null; confidence: number; cost: number | null };

type Line = {
  key: string;
  text: string | null;
  /** English reading of an Arabic receipt line. */
  textEn: string | null;
  qty: number;
  unitCost: string;
  candidates: Candidate[];
  selected: string | null;
  /** User asked to pick a different product than the suggestions. */
  searching: boolean;
};

type Photo = { preview: string; data: string; mediaType: "image/jpeg" };

let keySeq = 0;
const newKey = () => `l${++keySeq}`;

const looksHeic = (f: File) => /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);

/** Decode any photo, including iPhone HEIC (Chrome can't open those natively, so convert in the browser). */
async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file); // JPG/PNG/WEBP everywhere, HEIC in Safari
  } catch (e) {
    if (!looksHeic(file) && file.type) throw e;
    const { heicTo } = await import("heic-to/next"); // only downloaded when a HEIC photo is picked
    return heicTo({ blob: file, type: "bitmap" });
  }
}

async function resizeImage(file: File): Promise<Photo> {
  const bitmap = await decodeImage(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { preview: url, data: url.split(",")[1], mediaType: "image/jpeg" };
}

/** Pre-select the top suggestion only when it's clearly right. */
function autoPick(c: Candidate[]): string | null {
  if (!c.length) return null;
  const [a, b] = c;
  if (a.confidence >= 0.85 && (!b || a.confidence - b.confidence >= 0.2)) return a.variantId;
  return null;
}

export default function PurchasePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Purchase />
    </Suspense>
  );
}

function Purchase() {
  const params = useSearchParams();
  const { data: catalog } = useApi<{ items: CatalogItem[]; claudeReady: boolean }>("/api/catalog");
  const purchasesApi = useApi<PurchasesData>("/api/purchases");
  const company = purchasesApi.data?.company ?? "Cupcairo";
  const payerList = purchasesApi.data?.payers ?? ["Cupcairo", "Mark", "Michael", "Andrew"];
  // Nobody is pre-selected: whoever records the purchase must choose who paid.
  const [paidBy, setPaidBy] = useState<string>("");
  const payer = paidBy;
  const [purchasedOn, setPurchasedOn] = useState(() => todayInCairo());
  const [totalOverride, setTotalOverride] = useState("");
  const items = useMemo(() => catalog?.items ?? [], [catalog]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const [photos, setPhotos] = useState<Photo[]>([]);
  const [preparing, setPreparing] = useState<string | null>(null);
  // Coming from "Record purchase" on the To Buy list: start with that item.
  const [lines, setLines] = useState<Line[]>(() => {
    const variant = params.get("variant");
    if (!variant) return [];
    return [{ key: newKey(), text: null, textEn: null, qty: Number(params.get("qty")) || 1, unitCost: "", candidates: [], selected: variant, searching: false }];
  });
  const [reading, setReading] = useState<PurchaseReading | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ results: CommitResult[]; recordSaved: boolean; receiptSaved: boolean; recordError?: string; paidBy: string; total: number } | null>(null);
  const [note, setNote] = useState("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setPreparing([...files].some(looksHeic) ? "Converting HEIC photo…" : "Preparing photo…");
    try {
      const resized = await Promise.all([...files].slice(0, 6).map(resizeImage));
      setPhotos((p) => [...p, ...resized].slice(0, 6));
    } catch {
      setError("Couldn't open that photo. Try taking it again, or export it as JPG.");
    } finally {
      setPreparing(null);
    }
  }

  async function analyze() {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await api<PurchaseReading>("/api/purchase/analyze", {
        json: { images: photos.map((p) => ({ data: p.data, mediaType: p.mediaType })) },
      });
      setReading(res);
      setLines((prev) => [
        ...prev,
        ...res.lines.map((l) => ({
          key: newKey(),
          text: l.text,
          textEn: l.textEn && l.textEn !== l.text ? l.textEn : null,
          qty: l.quantity ?? 1,
          unitCost: l.unitPrice != null ? String(l.unitPrice) : "",
          candidates: l.candidates,
          selected: autoPick(l.candidates),
          searching: false,
        })),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const computedTotal = Math.round(lines.reduce((sum, l) => sum + (l.selected && l.unitCost ? Number(l.unitCost) * l.qty : 0), 0) * 100) / 100;
  const missingCost = lines.some((l) => l.selected && !l.unitCost);
  const total = totalOverride ? Number(totalOverride) : computedTotal;
  const needsTotal = Boolean(payer) && payer !== company && !(total > 0);
  const ready = lines.length > 0 && lines.every((l) => l.selected && l.qty > 0) && Boolean(payer) && !needsTotal;
  const totalUnits = lines.reduce((s, l) => s + (l.selected ? l.qty : 0), 0);
  const unresolved = lines.filter((l) => !l.selected).length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ results: CommitResult[]; record: { receiptSaved: boolean } | null; recordError?: string }>("/api/purchase/commit", {
        json: {
          note: note || reading?.storeName || "",
          paidBy: payer,
          purchasedOn,
          total,
          receipt: photos[0] ? { data: photos[0].data } : null,
          lines: lines.map((l) => ({ variantId: l.selected, qty: l.qty, unitCost: l.unitCost ? Number(l.unitCost) : null })),
        },
      });
      setResults({
        results: res.results,
        recordSaved: Boolean(res.record),
        receiptSaved: Boolean(res.record?.receiptSaved),
        recordError: res.recordError,
        paidBy: payer,
        total,
      });
      setPhotos([]);
      purchasesApi.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setResults(null);
    setLines([]);
    setReading(null);
    setNote("");
    setTotalOverride("");
    setPaidBy("");
    setPurchasedOn(todayInCairo());
  }

  if (results) return <Done outcome={results} company={company} onAgain={reset} />;

  const addItem = (item: PickerItem) => {
    const cost = (item as CatalogItem).cost;
    setLines((ls) => [...ls, { key: newKey(), text: null, textEn: null, qty: 1, unitCost: cost ? String(cost) : "", candidates: [], selected: item.id, searching: false }]);
  };

  return (
    <>
      <PageHeader title="Record a purchase" subtitle="Who paid, what you bought, and (optionally) the receipt photo." />

      {error && (
        <div className="mb-3">
          <ErrorBox message={error} />
        </div>
      )}

      <Card className="mb-4 space-y-4 p-4">
        <div>
          <label htmlFor="paid-by" className="mb-1.5 block text-xs font-medium text-fg-muted">
            Paid by
          </label>
          <div className="relative">
            <select
              id="paid-by"
              value={paidBy}
              onChange={(e) => setPaidBy(e.target.value)}
              required
              className={`h-11 w-full appearance-none rounded-xl bg-surface-2 pl-3 pr-10 text-sm ring-1 ring-inset outline-none [color-scheme:dark] focus:ring-2 focus:ring-neon ${
                paidBy ? "text-fg ring-line-strong" : "text-fg-subtle ring-line-strong"
              }`}
            >
              <option value="" disabled>
                Choose who paid…
              </option>
              {payerList.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <IconChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          </div>
          {payer && payer !== company && (
            <p className="mt-1.5 text-xs text-violet">
              {payer} paid from their own money. It&apos;ll show under Settlements on Today until {company} pays it back.
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div>
            <label htmlFor="purchased-on" className="mb-1.5 block text-xs font-medium text-fg-muted">
              Purchase date
            </label>
            <input
              id="purchased-on"
              type="date"
              value={purchasedOn}
              max={todayInCairo()}
              onChange={(e) => setPurchasedOn(e.target.value)}
              className="h-11 w-full rounded-xl bg-surface-2 px-3 text-sm ring-1 ring-inset ring-line-strong outline-none [color-scheme:dark] focus:ring-2 focus:ring-neon"
            />
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-fg-muted">Add items</div>
            <ProductPicker items={items} onPick={addItem} placeholder="Search product or SKU…" />
          </div>
        </div>

        <div className="border-t border-line pt-3">
          <input ref={cameraRef} type="file" accept="image/*,.heic,.heif" capture="environment" className="hidden" onChange={(e) => addFiles(e.target.files).then(() => (e.target.value = ""))} />
          <input ref={galleryRef} type="file" accept="image/*,.heic,.heif" className="hidden" onChange={(e) => addFiles(e.target.files).then(() => (e.target.value = ""))} />
          <div className="mb-1.5 text-xs font-medium text-fg-muted">Receipt photo (optional)</div>
          {photos.length === 0 ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => cameraRef.current?.click()}>
                <IconCamera className="size-4" /> Add receipt photo
              </Button>
              <Button variant="ghost" onClick={() => galleryRef.current?.click()}>
                From gallery
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
                <img src={photos[0].preview} alt="Receipt" className="h-24 w-20 rounded-lg object-cover ring-1 ring-line" />
                <button
                  onClick={() => setPhotos([])}
                  className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-surface-3 text-fg ring-1 ring-line-strong"
                  aria-label="Remove receipt photo"
                >
                  <IconX className="size-3.5" />
                </button>
              </div>
              <div className="min-w-0 flex-1 text-sm text-fg-muted">
                Attached. It&apos;s saved with this purchase in the log.
                {catalog?.claudeReady && (
                  <div className="mt-2">
                    <Button size="sm" variant="soft" loading={analyzing} onClick={analyze}>
                      {analyzing ? "Reading receipt…" : "Fill items from receipt"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          {preparing && (
            <div className="mt-2 flex items-center gap-2 text-sm text-fg-muted">
              <Spinner className="size-4" /> {preparing}
            </div>
          )}
        </div>
      </Card>

      {reading && (
        <div className="mb-2 text-sm text-fg-muted">
          Read {reading.lines.length} item{reading.lines.length === 1 ? "" : "s"} from the receipt{reading.storeName ? ` (${reading.storeName})` : ""}. Check each one.
        </div>
      )}

      {lines.length > 0 && (
        <div className="space-y-2.5">
          {lines.map((l) => (
            <LineCard
              key={l.key}
              line={l}
              item={l.selected ? byId.get(l.selected) : undefined}
              items={items}
              onChange={(patch) => update(l.key, patch)}
              onRemove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
            />
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <Card className="mt-3 grid gap-2 p-3 sm:grid-cols-[1fr_12rem]">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (supplier, invoice no.): optional"
            aria-label="Note"
            className="h-11 w-full rounded-xl bg-surface-2 px-3 text-sm ring-1 ring-inset ring-line-strong outline-none focus:ring-2 focus:ring-neon"
          />
          <div>
            <div className="relative">
              <input
                id="total-paid"
                inputMode="decimal"
                value={totalOverride}
                onChange={(e) => setTotalOverride(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder={computedTotal ? String(computedTotal) : "Total paid"}
                aria-label="Total paid in EGP"
                className={`h-11 w-full rounded-xl bg-surface-2 pl-3 pr-12 text-sm tabular-nums ring-1 ring-inset outline-none focus:ring-2 focus:ring-neon ${
                  needsTotal ? "ring-pink/60" : "ring-line-strong"
                }`}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">EGP</span>
            </div>
            <p className="mt-1 text-[11px] text-fg-subtle">{totalOverride ? "Entered by you" : missingCost ? "Sum of item costs (some missing)" : "Sum of item costs; type to change"}</p>
          </div>
        </Card>
      )}

      {lines.length > 0 && (
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 mt-3 md:bottom-4">
          <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface/95 p-2.5 pl-4 shadow-lg shadow-black/50 backdrop-blur">
            <div className="min-w-0 flex-1 text-xs leading-tight text-fg-muted">
              <div className="text-base font-semibold tabular-nums text-fg">{money(total)}</div>
              <div className="truncate">
                {payer ? <span className={payer === company ? "" : "text-violet"}>Paid by {payer}</span> : <span className="text-pink">Who paid?</span>} · {purchasedOn}
              </div>
            </div>
            <Button variant="primary" size="lg" className="shrink-0" disabled={!ready} loading={saving} onClick={save}>
              {unresolved
                ? `Choose ${unresolved} product${unresolved > 1 ? "s" : ""}`
                : !payer
                  ? "Choose who paid"
                  : needsTotal
                    ? "Enter total"
                    : `Save · ${totalUnits} unit${totalUnits === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      )}

      <PurchaseLog api={purchasesApi} company={company} catalogItems={items} />
    </>
  );
}

function LineCard({
  line,
  item,
  items,
  onChange,
  onRemove,
}: {
  line: Line;
  item: CatalogItem | undefined;
  items: CatalogItem[];
  onChange: (patch: Partial<Line>) => void;
  onRemove: () => void;
}) {
  const needsChoice = !line.selected;
  return (
    <Card className={`p-3.5 ${needsChoice ? "ring-2 ring-amber/50" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {line.text && (
            <div className="text-xs text-fg-muted">
              On the photo: “<bdi>{line.text}</bdi>”
              {line.textEn && <span className="block text-fg-subtle">English: {line.textEn}</span>}
            </div>
          )}
          {item && !line.searching ? (
            <div className="mt-1.5 flex items-center gap-3">
              <Thumb src={item.image} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium leading-snug"><bdi>{item.name}</bdi></div>
                <div className="text-xs text-fg-muted">
                  Shopify now {item.shopifyQty}
                  {item.cost != null ? ` · cost ${money(item.cost)}` : ""}
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <button onClick={onRemove} className="rounded-lg p-1 text-fg-subtle hover:bg-surface-3 hover:text-fg" aria-label="Remove item">
          <IconX className="size-4" />
        </button>
      </div>

      {needsChoice && !line.searching && (
        <div className="mt-2">
          <div className="mb-1.5 text-sm font-medium text-amber">
            {line.candidates.length ? "Which product is this?" : line.text ? "No match found. Search for it:" : "Search for the product:"}
          </div>
          <div className="space-y-1.5">
            {line.candidates.map((c) => (
              <button
                key={c.variantId}
                onClick={() => onChange({ selected: c.variantId, unitCost: line.unitCost || (c.cost ? String(c.cost) : "") })}
                className="flex w-full items-center gap-3 rounded-xl p-2 text-left ring-1 ring-inset ring-line hover:bg-surface-2"
              >
                <Thumb src={c.image} />
                <span className="min-w-0 flex-1 text-sm"><bdi>{c.name}</bdi></span>
                <Badge tone={c.confidence >= 0.8 ? "green" : c.confidence >= 0.5 ? "amber" : "stone"}>{Math.round(c.confidence * 100)}%</Badge>
              </button>
            ))}
          </div>
        </div>
      )}

      {(line.searching || (needsChoice && !line.candidates.length)) && (
        <div className="mt-2">
          <ProductPicker items={items} autoFocus={line.searching} onPick={(p) => onChange({ selected: p.id, searching: false })} />
        </div>
      )}
      {needsChoice && line.candidates.length > 0 && !line.searching && (
        <button onClick={() => onChange({ searching: true })} className="mt-2 text-xs font-medium text-neon underline">
          None of these, search
        </button>
      )}

      {line.selected && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <div className="mb-1 text-xs text-fg-muted">Quantity</div>
            <div className="flex items-center rounded-xl ring-1 ring-inset ring-line-strong">
              <button className="grid size-10 place-items-center text-fg-muted" onClick={() => onChange({ qty: Math.max(1, line.qty - 1) })} aria-label="Less">
                <IconMinus className="size-4" />
              </button>
              <input
                inputMode="numeric"
                value={line.qty}
                onChange={(e) => onChange({ qty: Math.max(0, Number.parseInt(e.target.value.replace(/\D/g, "") || "0", 10)) })}
                className="h-10 w-12 bg-transparent text-center font-semibold tabular-nums outline-none"
              />
              <button className="grid size-10 place-items-center text-fg-muted" onClick={() => onChange({ qty: line.qty + 1 })} aria-label="More">
                <IconPlus className="size-4" />
              </button>
            </div>
          </div>
          <div className="min-w-28 flex-1">
            <div className="mb-1 text-xs text-fg-muted">Cost per unit (EGP)</div>
            <input
              inputMode="decimal"
              value={line.unitCost}
              onChange={(e) => onChange({ unitCost: e.target.value.replace(/[^\d.]/g, "") })}
              placeholder={item?.cost != null ? `Keep ${item.cost}` : "e.g. 350"}
              className="h-10 w-full rounded-xl px-3 text-sm bg-surface-2 ring-1 ring-inset ring-line-strong outline-none focus:ring-2 focus:ring-neon"
            />
          </div>
          {!line.searching && (
            <button onClick={() => onChange({ selected: null, searching: false })} className="h-10 text-xs font-medium text-fg-muted underline">
              Change product
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

type Outcome = { results: CommitResult[]; recordSaved: boolean; receiptSaved: boolean; recordError?: string; paidBy: string; total: number };

function Done({ outcome, company, onAgain }: { outcome: Outcome; company: string; onAgain: () => void }) {
  const { results } = outcome;
  const failed = results.filter((r) => !r.shopify.ok || !r.sheet.ok || !r.cost.ok);
  return (
    <>
      <PageHeader title={failed.length || outcome.recordError ? "Saved with problems" : "Purchase saved"} />
      <Card className="mb-3 p-4">
        {outcome.recordSaved ? (
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2 font-medium text-green">
              <IconCheck className="size-4" /> Added to the purchase log
              {outcome.receiptSaved && <span className="font-normal text-fg-muted">· receipt photo saved</span>}
            </div>
            {outcome.paidBy !== company && (
              <p className="text-violet">
                {company} owes {outcome.paidBy} {money(outcome.total)}. It&apos;s on Today → Settlements until you mark it settled.
              </p>
            )}
          </div>
        ) : (
          <ErrorBox message={`Stock was updated, but the purchase log wasn't saved: ${outcome.recordError ?? "unknown error"}`} />
        )}
      </Card>
      <div className="space-y-2.5">
        {results.map((r) => (
          <Card key={r.variantId} className="p-3.5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 text-sm font-medium">
                <bdi>{r.name}</bdi>
              </div>
              <Badge tone="accent">+{r.qty}</Badge>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              <Status ok={r.shopify.ok} label={`Shopify${r.shopify.after != null ? ` → ${r.shopify.after}` : ""}`} error={r.shopify.error} />
              <Status ok={r.cost.ok} skipped={r.cost.skipped} label="Cost" error={r.cost.error} />
              <Status ok={r.sheet.ok} skipped={r.sheet.skipped} label={`Sheet${r.sheet.after != null ? ` → ${r.sheet.after}` : ""}`} error={r.sheet.error} />
            </div>
          </Card>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" onClick={onAgain}>
          Record another
        </Button>
        <Link href="/" className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-medium ring-1 ring-inset ring-line-strong">
          Back to Today
        </Link>
      </div>
    </>
  );
}

type PurchasesData = { purchases: PurchaseRecord[]; payers: string[]; company: string; today: string };

/** Every purchase ever recorded, newest first, filterable by who paid / unsettled. */
function PurchaseLog({
  api: purchasesApi,
  company,
  catalogItems,
}: {
  api: ReturnType<typeof useApi<PurchasesData>>;
  company: string;
  catalogItems: CatalogItem[];
}) {
  const { data, error, loading, reload } = purchasesApi;
  const [filter, setFilter] = useState<string>("all");
  const [shown, setShown] = useState(20);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<PurchaseRecord | null>(null);
  const [deleting, setDeleting] = useState<PurchaseRecord | null>(null);
  const toast = useToast();

  const all = data?.purchases ?? [];
  const list = all.filter((p) =>
    filter === "all" ? true : filter === "owed" ? p.paidBy !== company && !p.settledOn : p.paidBy === filter,
  );
  const monthTotal = all.filter((p) => p.purchasedOn >= (data?.today ?? "").slice(0, 7)).reduce((s, p) => s + p.total, 0);

  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Purchase log</h2>
          <p className="text-xs text-fg-muted">
            {all.length} purchase{all.length === 1 ? "" : "s"} recorded · {money(monthTotal)} this month
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={reload} disabled={loading}>
          {loading ? <Spinner className="size-4" /> : "Refresh"}
        </Button>
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {data && (
        <>
          <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
            {["all", "owed", ...data.payers].map((f) => (
              <button
                key={f}
                onClick={() => {
                  setFilter(f);
                  setShown(20);
                }}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${
                  filter === f ? "bg-neon text-neon-ink ring-neon" : "bg-surface text-fg-muted ring-line"
                }`}
              >
                {f === "all" ? "All" : f === "owed" ? "Not settled" : f}
              </button>
            ))}
          </div>
          {list.length === 0 ? (
            <Empty title="No purchases here yet">Saved purchases appear here, with who paid and the receipt.</Empty>
          ) : (
            <Card className="divide-y divide-line overflow-hidden">
              {list.slice(0, shown).map((p) => {
                const personal = p.paidBy !== company;
                const units = p.items.reduce((s, i) => s + i.qty, 0);
                return (
                  <div key={p.id}>
                    <button onClick={() => setOpen(open === p.id ? null : p.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60">
                      <div className="w-16 shrink-0 text-xs tabular-nums text-fg-muted">{p.purchasedOn.slice(5).replace("-", "/")}</div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          <bdi>{p.items.map((i) => i.name).join(", ") || "Purchase"}</bdi>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                          <span>
                            {p.items.length} item{p.items.length === 1 ? "" : "s"} · {units} unit{units === 1 ? "" : "s"}
                          </span>
                          <Badge tone={personal ? "violet" : "stone"}>{p.paidBy}</Badge>
                          {personal && (p.settledOn ? <Badge tone="green">Settled {p.settledOn}</Badge> : <Badge tone="amber">Not settled</Badge>)}
                          {p.receiptUrl && <Badge tone="cyan">Receipt</Badge>}
                        </div>
                      </div>
                      <div className="shrink-0 text-sm font-semibold tabular-nums">{money(p.total)}</div>
                    </button>
                    {open === p.id && (
                      <div className="grid gap-3 bg-surface-2/40 px-4 py-3 sm:grid-cols-[1fr_auto]">
                        <div className="space-y-1 text-sm">
                          {p.items.map((i) => (
                            <div key={i.variantId} className="flex gap-2">
                              <span className="w-10 shrink-0 tabular-nums text-fg-muted">{i.qty}×</span>
                              <bdi className="min-w-0 flex-1">{i.name}</bdi>
                              <span className="shrink-0 tabular-nums text-fg-muted">{i.unitCost != null ? money(i.unitCost) : "—"}</span>
                            </div>
                          ))}
                          {p.note && <p className="pt-1 text-xs text-fg-muted">Note: {p.note}</p>}
                        </div>
                        {p.receiptUrl && (
                          <a href={p.receiptUrl} target="_blank" rel="noreferrer" className="block">
                            {/* eslint-disable-next-line @next/next/no-img-element -- Shopify Files CDN */}
                            <img src={p.receiptUrl} alt="Receipt" className="h-32 w-28 rounded-lg object-cover ring-1 ring-line" />
                          </a>
                        )}
                        <div className="flex gap-2 sm:col-span-2">
                          <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" className="text-pink hover:text-pink" onClick={() => setDeleting(p)}>
                            Delete
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          )}
          {editing && (
            <EditPurchaseModal
              purchase={editing}
              payers={data.payers}
              company={company}
              today={data.today}
              catalogItems={catalogItems}
              onClose={() => setEditing(null)}
              onSaved={(msg) => {
                setEditing(null);
                toast.show(msg);
                reload();
              }}
            />
          )}
          {deleting && (
            <DeletePurchaseModal
              purchase={deleting}
              company={company}
              onClose={() => setDeleting(null)}
              onDeleted={(msg) => {
                setDeleting(null);
                setOpen(null);
                toast.show(msg);
                reload();
              }}
            />
          )}
          {toast.node}
          {list.length > shown && (
            <div className="mt-3 text-center">
              <Button size="sm" variant="secondary" onClick={() => setShown((n) => n + 30)}>
                Show more ({list.length - shown} older)
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

type StockOutcome = { shopify: boolean; sheet: boolean; changed: number; error?: string } | null;
const stockNote = (s: StockOutcome) => (s?.error ? ` (stock: ${s.error})` : s?.changed ? " and stock updated" : "");

function DeletePurchaseModal({
  purchase,
  company,
  onClose,
  onDeleted,
}: {
  purchase: PurchaseRecord;
  company: string;
  onClose: () => void;
  onDeleted: (msg: string) => void;
}) {
  const units = purchase.items.reduce((s, i) => s + i.qty, 0);
  const [removeStock, setRemoveStock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ stock: StockOutcome }>("/api/purchases", { json: { action: "delete", id: purchase.id, removeStock } });
      onDeleted(`Purchase deleted${stockNote(r.stock)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Delete this purchase?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={confirm}>
            Delete purchase
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-xl bg-surface-2 p-3 ring-1 ring-inset ring-line">
          <div className="font-medium">
            {purchase.purchasedOn} · {purchase.paidBy} · {money(purchase.total)}
          </div>
          <div className="mt-1 text-fg-muted">
            <bdi>{purchase.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</bdi>
          </div>
        </div>
        <label className="flex items-start gap-2.5 rounded-xl p-2 hover:bg-surface-2">
          <input type="checkbox" checked={removeStock} onChange={(e) => setRemoveStock(e.target.checked)} className="mt-0.5 size-4 accent-[#c5ff3c]" />
          <span>
            Also remove the <b>{units} unit{units === 1 ? "" : "s"}</b> this purchase added to stock (Shopify and the actual sheet).
            <span className="block text-xs text-fg-muted">Untick if the stock itself is correct and only the record was a mistake.</span>
          </span>
        </label>
        {purchase.paidBy !== company && !purchase.settledOn && (
          <p className="text-xs text-violet">
            It also disappears from Settlements, so {company} will no longer owe {purchase.paidBy} {money(purchase.total)} for it.
          </p>
        )}
        <p className="text-xs text-fg-muted">This can&apos;t be undone. The receipt photo is deleted too.</p>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

type EditItem = { variantId: string; name: string; qty: number; unitCost: string };

function EditPurchaseModal({
  purchase,
  payers,
  company,
  today,
  catalogItems,
  onClose,
  onSaved,
}: {
  purchase: PurchaseRecord;
  payers: string[];
  company: string;
  today: string;
  catalogItems: CatalogItem[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [paidBy, setPaidBy] = useState(purchase.paidBy);
  const [purchasedOn, setPurchasedOn] = useState(purchase.purchasedOn);
  const [note, setNote] = useState(purchase.note);
  const [itemsState, setItems] = useState<EditItem[]>(
    purchase.items.map((i) => ({ variantId: i.variantId, name: i.name, qty: i.qty, unitCost: i.unitCost != null ? String(i.unitCost) : "" })),
  );
  const [totalText, setTotalText] = useState(String(purchase.total));
  const [settled, setSettled] = useState(Boolean(purchase.settledOn));
  const [settledOn, setSettledOn] = useState(purchase.settledOn ?? today);
  const [adjustStock, setAdjustStock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const before = new Map(purchase.items.map((i) => [i.variantId, i.qty]));
  const qtyChanges = [...new Set([...before.keys(), ...itemsState.map((i) => i.variantId)])]
    .map((id) => ({ id, d: (itemsState.find((i) => i.variantId === id)?.qty ?? 0) - (before.get(id) ?? 0) }))
    .filter((c) => c.d !== 0);
  const itemsTotal = Math.round(itemsState.reduce((s, i) => s + (i.unitCost ? Number(i.unitCost) * i.qty : 0), 0) * 100) / 100;
  const personal = paidBy !== company;

  const setItem = (id: string, patch: Partial<EditItem>) => setItems((l) => l.map((i) => (i.variantId === id ? { ...i, ...patch } : i)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ stock: StockOutcome }>("/api/purchases", {
        json: {
          action: "update",
          id: purchase.id,
          adjustStock: adjustStock && qtyChanges.length > 0,
          patch: {
            paidBy,
            purchasedOn,
            note,
            total: Number(totalText || 0),
            settledOn: personal && settled ? settledOn : null,
            items: itemsState.map((i) => ({ variantId: i.variantId, name: i.name, qty: i.qty, unitCost: i.unitCost ? Number(i.unitCost) : null })),
          },
        },
      });
      onSaved(`Purchase updated${stockNote(r.stock)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const field = "h-11 w-full rounded-xl bg-surface-2 px-3 text-sm ring-1 ring-inset ring-line-strong outline-none [color-scheme:dark] focus:ring-2 focus:ring-neon";
  return (
    <Modal
      title="Edit purchase"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!itemsState.length} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="edit-paid-by" className="mb-1 block text-xs font-medium text-fg-muted">
              Paid by
            </label>
            <select id="edit-paid-by" value={paidBy} onChange={(e) => setPaidBy(e.target.value)} className={field}>
              {payers.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="edit-date" className="mb-1 block text-xs font-medium text-fg-muted">
              Purchase date
            </label>
            <input id="edit-date" type="date" value={purchasedOn} max={today} onChange={(e) => setPurchasedOn(e.target.value)} className={field} />
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-fg-muted">Items</div>
          <div className="space-y-2">
            {itemsState.map((i) => (
              <div key={i.variantId} className="rounded-xl bg-surface-2 p-2.5 ring-1 ring-inset ring-line">
                <div className="flex items-start gap-2">
                  <bdi className="min-w-0 flex-1 text-sm">{i.name}</bdi>
                  <button onClick={() => setItems((l) => l.filter((x) => x.variantId !== i.variantId))} className="p-0.5 text-fg-subtle hover:text-pink" aria-label={`Remove ${i.name}`}>
                    <IconX className="size-4" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex items-center rounded-lg bg-surface ring-1 ring-inset ring-line-strong">
                    <button className="grid size-9 place-items-center" onClick={() => setItem(i.variantId, { qty: Math.max(1, i.qty - 1) })} aria-label="Less">
                      <IconMinus className="size-4" />
                    </button>
                    <input
                      inputMode="numeric"
                      value={i.qty}
                      onChange={(e) => setItem(i.variantId, { qty: Math.max(1, Number.parseInt(e.target.value.replace(/\D/g, "") || "1", 10)) })}
                      aria-label="Quantity"
                      className="h-9 w-10 bg-transparent text-center text-sm font-semibold tabular-nums outline-none"
                    />
                    <button className="grid size-9 place-items-center" onClick={() => setItem(i.variantId, { qty: i.qty + 1 })} aria-label="More">
                      <IconPlus className="size-4" />
                    </button>
                  </div>
                  <input
                    inputMode="decimal"
                    value={i.unitCost}
                    onChange={(e) => setItem(i.variantId, { unitCost: e.target.value.replace(/[^\d.]/g, "") })}
                    placeholder="Cost / unit"
                    aria-label="Cost per unit"
                    className="h-9 min-w-0 flex-1 rounded-lg bg-surface px-3 text-sm ring-1 ring-inset ring-line-strong outline-none focus:ring-2 focus:ring-neon"
                  />
                  {before.get(i.variantId) !== i.qty && (
                    <Badge tone={i.qty > (before.get(i.variantId) ?? 0) ? "green" : "amber"}>
                      {i.qty > (before.get(i.variantId) ?? 0) ? "+" : ""}
                      {i.qty - (before.get(i.variantId) ?? 0)}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
            <ProductPicker
              items={catalogItems}
              placeholder="Add another item…"
              onPick={(p) =>
                setItems((l) =>
                  l.some((x) => x.variantId === p.id)
                    ? l.map((x) => (x.variantId === p.id ? { ...x, qty: x.qty + 1 } : x))
                    : [...l, { variantId: p.id, name: p.name, qty: 1, unitCost: (p as CatalogItem).cost != null ? String((p as CatalogItem).cost) : "" }],
                )
              }
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="edit-total" className="mb-1 block text-xs font-medium text-fg-muted">
              Total paid (EGP)
            </label>
            <input id="edit-total" inputMode="decimal" value={totalText} onChange={(e) => setTotalText(e.target.value.replace(/[^\d.]/g, ""))} className={field} />
            {itemsTotal > 0 && Number(totalText) !== itemsTotal && (
              <button onClick={() => setTotalText(String(itemsTotal))} className="mt-1 text-[11px] text-neon underline">
                Use item total {money(itemsTotal)}
              </button>
            )}
          </div>
          <div>
            <label htmlFor="edit-note" className="mb-1 block text-xs font-medium text-fg-muted">
              Note
            </label>
            <input id="edit-note" value={note} onChange={(e) => setNote(e.target.value)} className={field} />
          </div>
        </div>

        {personal && (
          <div className="rounded-xl p-3 ring-1 ring-inset ring-violet/30">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={settled} onChange={(e) => setSettled(e.target.checked)} className="size-4 accent-[#bb8cff]" />
              {company} paid {paidBy} back
            </label>
            {settled && (
              <div className="mt-2">
                <label htmlFor="edit-settled" className="mb-1 block text-[11px] font-medium text-fg-muted">
                  Settled on ({purchasedOn} – today)
                </label>
                <input id="edit-settled" type="date" value={settledOn} min={purchasedOn} max={today} onChange={(e) => setSettledOn(e.target.value)} className={field} />
              </div>
            )}
          </div>
        )}

        {qtyChanges.length > 0 && (
          <label className="flex items-start gap-2.5 rounded-xl bg-surface-2 p-3 text-sm ring-1 ring-inset ring-line">
            <input type="checkbox" checked={adjustStock} onChange={(e) => setAdjustStock(e.target.checked)} className="mt-0.5 size-4 accent-[#c5ff3c]" />
            <span>
              Update stock by the quantity changes (
              {qtyChanges
                .map((c) => `${c.d > 0 ? "+" : ""}${c.d} ${itemsState.find((i) => i.variantId === c.id)?.name ?? purchase.items.find((i) => i.variantId === c.id)?.name ?? ""}`)
                .join(", ")}
              )
              <span className="block text-xs text-fg-muted">In Shopify and the actual sheet.</span>
            </span>
          </label>
        )}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

function Status({ ok, skipped, label, error }: { ok: boolean; skipped?: boolean; label: string; error?: string }) {
  if (skipped) return <Badge tone="stone">{label}: skipped</Badge>;
  return ok ? (
    <Badge tone="green">
      <IconCheck className="size-3.5" /> {label}
    </Badge>
  ) : (
    <Badge tone="red" className="whitespace-normal">
      {label} failed{error ? `: ${error}` : ""}
    </Badge>
  );
}
