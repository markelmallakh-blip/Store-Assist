"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useRef, useState } from "react";
import type { CommitResult } from "@/lib/purchase";
import type { PurchaseReading } from "@/lib/receipt";
import { IconCamera, IconCheck, IconMinus, IconPlus, IconX } from "@/components/icons";
import { ProductPicker, type PickerItem } from "@/components/product-picker";
import { api, Badge, Button, Card, ErrorBox, money, PageHeader, Spinner, Thumb, useApi } from "@/components/ui";

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
  const [results, setResults] = useState<CommitResult[] | null>(null);
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
      setPhotos([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const ready = lines.length > 0 && lines.every((l) => l.selected && l.qty > 0);
  const totalUnits = lines.reduce((s, l) => s + (l.selected ? l.qty : 0), 0);
  const unresolved = lines.filter((l) => !l.selected).length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ results: CommitResult[] }>("/api/purchase/commit", {
        json: {
          note: note || reading?.storeName || "",
          lines: lines.map((l) => ({ variantId: l.selected, qty: l.qty, unitCost: l.unitCost ? Number(l.unitCost) : null })),
        },
      });
      setResults(res.results);
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
  }

  if (results) return <Done results={results} onAgain={reset} />;

  return (
    <>
      <PageHeader title="Record a purchase" subtitle="Snap the receipt or the products. Check the matches, then add them to stock." />

      {catalog && !catalog.claudeReady && (
        <div className="mb-3 rounded-2xl border border-amber/30 bg-amber/10 p-4 text-sm text-amber">
          Reading photos needs an AI key (OpenAI/ChatGPT or Claude).{" "}
          <Link href="/settings#receipt-reading" className="font-medium underline">
            Connect it in Settings
          </Link>{" "}
          (one time). You can still add items by name below.
        </div>
      )}
      {error && (
        <div className="mb-3">
          <ErrorBox message={error} />
        </div>
      )}

      <Card className="mb-4 p-4">
        <input ref={cameraRef} type="file" accept="image/*,.heic,.heif" capture="environment" className="hidden" onChange={(e) => addFiles(e.target.files).then(() => (e.target.value = ""))} />
        <input ref={galleryRef} type="file" accept="image/*,.heic,.heif" multiple className="hidden" onChange={(e) => addFiles(e.target.files).then(() => (e.target.value = ""))} />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="lg" className="flex-1 sm:flex-none" onClick={() => cameraRef.current?.click()}>
            <IconCamera /> Take photo
          </Button>
          <Button variant="secondary" size="lg" className="flex-1 sm:flex-none" onClick={() => galleryRef.current?.click()}>
            From gallery
          </Button>
        </div>
        {preparing && (
          <div className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
            <Spinner className="size-4" /> {preparing}
          </div>
        )}
        {photos.length > 0 && (
          <>
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {photos.map((p, i) => (
                <div key={i} className="relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
                  <img src={p.preview} alt="" className="h-24 w-20 rounded-lg object-cover ring-1 ring-line" />
                  <button
                    onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-surface-3 text-fg ring-1 ring-line-strong"
                    aria-label="Remove photo"
                  >
                    <IconX className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <Button variant="primary" className="mt-3 w-full" loading={analyzing} onClick={analyze}>
              {analyzing ? "Reading photos…" : `Read ${photos.length} photo${photos.length > 1 ? "s" : ""}`}
            </Button>
            {analyzing && <p className="mt-2 text-center text-xs text-fg-muted">Matching against your catalog, this takes a few seconds.</p>}
          </>
        )}
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-1.5 text-xs font-medium text-fg-muted">Or add an item by name</div>
          <ProductPicker
            items={items}
            onPick={(item) =>
              setLines((ls) => [
                ...ls,
                { key: newKey(), text: null, textEn: null, qty: 1, unitCost: (item as CatalogItem).cost ? String((item as CatalogItem).cost) : "", candidates: [], selected: item.id, searching: false },
              ])
            }
          />
        </div>
      </Card>

      {reading && (
        <div className="mb-2 text-sm text-fg-muted">
          Read as {reading.kind === "receipt" ? "a receipt" : reading.kind === "product_photo" ? "product photos" : "photos"}
          {reading.storeName ? ` from ${reading.storeName}` : ""}. {reading.lines.length} item{reading.lines.length === 1 ? "" : "s"} found.
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
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 mt-4 md:bottom-4">
          <Card className="p-3 shadow-lg">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (supplier, invoice no.) — optional"
              className="mb-2 h-10 w-full rounded-lg bg-surface-2 px-3 text-sm ring-1 ring-inset ring-line-strong outline-none focus:ring-2 focus:ring-neon"
            />
            <Button variant="primary" size="lg" className="w-full" disabled={!ready} loading={saving} onClick={save}>
              {unresolved ? `Choose the product for ${unresolved} item${unresolved > 1 ? "s" : ""}` : `Add ${totalUnits} unit${totalUnits === 1 ? "" : "s"} to stock`}
            </Button>
            <p className="mt-1.5 text-center text-[11px] text-fg-muted">Adds to Shopify inventory, updates cost per item, and adds to the actual inventory sheet.</p>
          </Card>
        </div>
      )}
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

function Done({ results, onAgain }: { results: CommitResult[]; onAgain: () => void }) {
  const failed = results.filter((r) => !r.shopify.ok || !r.sheet.ok || !r.cost.ok);
  return (
    <>
      <PageHeader title={failed.length ? "Saved with problems" : "Added to stock"} />
      <div className="space-y-2.5">
        {results.map((r) => (
          <Card key={r.variantId} className="p-3.5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 text-sm font-medium"><bdi>{r.name}</bdi></div>
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
