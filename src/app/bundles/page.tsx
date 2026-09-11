"use client";

import { useMemo, useState } from "react";
import type { Component } from "@/lib/types";
import { IconMinus, IconPlus, IconX } from "@/components/icons";
import { ProductPicker, type PickerItem } from "@/components/product-picker";
import { api, Badge, Button, Card, Empty, ErrorBox, PageHeader, Skeleton, Thumb, useApi, useToast } from "@/components/ui";

type Suggestion = { variantId: string; qty: number; confidence: number; label: string };
type BundleVariant = {
  variantId: string;
  variantTitle: string | null;
  name: string;
  notBundle: boolean;
  source: "saved" | "auto" | null;
  components: (Component & { name: string })[] | null;
  suggestion: Suggestion[];
};
type BundleProduct = {
  productId: string;
  productTitle: string;
  image: string | null;
  productType: string;
  vendor: string;
  status: string;
  variants: BundleVariant[];
};
type Data = { products: BundleProduct[]; singles: PickerItem[] };
type Tab = "todo" | "done" | "not";

const pending = (v: BundleVariant) => !v.components && !v.notBundle;

export default function BundlesPage() {
  const { data, error, loading, reload, setData } = useApi<Data>("/api/bundles");
  const [tab, setTab] = useState<Tab>("todo");
  const toast = useToast();

  const names = useMemo(() => new Map((data?.singles ?? []).map((s) => [s.id, s.name])), [data]);

  const groups = useMemo(() => {
    const all = data?.products ?? [];
    return {
      todo: all.filter((p) => p.variants.some(pending)),
      done: all.filter((p) => !p.variants.some(pending) && p.variants.some((v) => v.components)),
      not: all.filter((p) => p.variants.every((v) => v.notBundle)),
    };
  }, [data]);

  async function save(entries: { variantId: string; components: Component[] | null }[], message: string) {
    await api("/api/bundles", { json: { entries } });
    setData((d) =>
      d
        ? {
            ...d,
            products: d.products.map((p) => ({
              ...p,
              variants: p.variants.map((v) => {
                const e = entries.find((x) => x.variantId === v.variantId);
                if (!e) return v;
                if (e.components === null) return { ...v, components: null, notBundle: false, source: null };
                if (!e.components.length) return { ...v, components: null, notBundle: true, source: null, suggestion: [] };
                return {
                  ...v,
                  notBundle: false,
                  source: "saved" as const,
                  components: e.components.map((c) => ({ ...c, name: names.get(c.variantId) ?? "Item" })),
                };
              }),
            })),
          }
        : d,
    );
    toast.show(message);
  }

  const list = groups[tab];

  return (
    <>
      <PageHeader
        title="Bundles"
        subtitle="Which single items each bundle takes from stock. Clear cases like “2 Jars …” are set automatically (selling one removes 2 singles from the sheet); the rest wait here for you."
        onRefresh={reload}
        loading={loading}
      />
      {error && <ErrorBox message={error} onRetry={reload} />}
      {!data && loading && <Skeleton rows={4} />}

      {data && (
        <>
          <div className="mb-4 flex gap-1.5">
            {(
              [
                ["todo", "Needs setup"],
                ["done", "Set up"],
                ["not", "Not bundles"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${tab === id ? "bg-neon text-neon-ink ring-neon glow-neon" : "bg-surface text-fg-muted ring-line"}`}
              >
                {label} · {groups[id].length}
              </button>
            ))}
          </div>

          {list.length === 0 && (
            <Empty title={tab === "todo" ? "All bundles are set up" : "Nothing here yet"}>
              {tab === "todo" ? "New bundle-looking products will show up here automatically." : null}
            </Empty>
          )}

          <div className="space-y-4">
            {list.map((p) => (
              <ProductCard key={p.productId} product={p} singles={data.singles} onSave={save} onError={(m) => toast.show(m, "err")} />
            ))}
          </div>
        </>
      )}
      {toast.node}
    </>
  );
}

function ProductCard({
  product,
  singles,
  onSave,
  onError,
}: {
  product: BundleProduct;
  singles: PickerItem[];
  onSave: (entries: { variantId: string; components: Component[] | null }[], message: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const todo = product.variants.filter(pending);
  const withSuggestion = todo.filter((v) => v.suggestion.length);
  const doneCount = product.variants.filter((v) => v.components).length;
  const [open, setOpen] = useState(todo.length > 0);

  const run = async (key: string, entries: { variantId: string; components: Component[] | null }[], msg: string) => {
    setBusy(key);
    try {
      await onSave(entries, msg);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 p-3.5 text-left">
        <Thumb src={product.image} />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug"><bdi>{product.productTitle}</bdi></div>
          <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-fg-muted">
            <span>{product.productType || "No type"}</span>
            {product.status !== "ACTIVE" && <Badge tone="stone">{product.status.toLowerCase()}</Badge>}
            <Badge tone={todo.length ? "amber" : "green"}>
              {doneCount}/{product.variants.length} set up
            </Badge>
          </div>
        </div>
        <span className="text-fg-subtle">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="border-t border-line">
          {todo.length > 0 && (
            <div className="flex flex-wrap gap-2 bg-surface-2 px-3.5 py-2.5">
              {withSuggestion.length > 0 && (
                <Button
                  size="sm"
                  variant="soft"
                  loading={busy === "all"}
                  onClick={() =>
                    run(
                      "all",
                      withSuggestion.map((v) => ({ variantId: v.variantId, components: v.suggestion.map((s) => ({ variantId: s.variantId, qty: s.qty })) })),
                      `Saved ${withSuggestion.length} recipe${withSuggestion.length > 1 ? "s" : ""}`,
                    )
                  }
                >
                  Accept {withSuggestion.length} suggestion{withSuggestion.length > 1 ? "s" : ""}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                loading={busy === "not"}
                onClick={() => run("not", todo.map((v) => ({ variantId: v.variantId, components: [] })), "Marked as not a bundle")}
              >
                Not a bundle (has its own stock)
              </Button>
            </div>
          )}
          <div className="divide-y divide-line">
            {product.variants.map((v) => (
              <VariantRow key={v.variantId} v={v} singles={singles} busy={busy === v.variantId} onSave={(entries, msg) => run(v.variantId, entries, msg)} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function VariantRow({
  v,
  singles,
  busy,
  onSave,
}: {
  v: BundleVariant;
  singles: PickerItem[];
  busy: boolean;
  onSave: (entries: { variantId: string; components: Component[] | null }[], message: string) => void;
}) {
  const [editing, setEditing] = useState<(Component & { name: string })[] | null>(null);
  const names = new Map(singles.map((s) => [s.id, s.name]));
  const low = v.suggestion.some((s) => s.confidence < 0.8);

  const startEdit = () =>
    setEditing(
      v.components?.map((c) => ({ ...c })) ??
        v.suggestion.map((s) => ({ variantId: s.variantId, qty: s.qty, name: s.label })),
    );

  return (
    <div className="px-3.5 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{v.variantTitle ?? "Single variant"}</div>
          {!editing && (
            <div className="mt-1 text-sm">
              {v.components ? (
                <div>
                  <Recipe items={v.components} />
                  {v.source === "auto" && (
                    <Badge tone="blue" className="ml-1.5">
                      Automatic
                    </Badge>
                  )}
                </div>
              ) : v.notBundle ? (
                <span className="text-fg-muted">Not a bundle — its own stock is used.</span>
              ) : v.suggestion.length ? (
                <div>
                  <span className="mr-1.5 text-xs text-fg-muted">Suggested:</span>
                  <Recipe items={v.suggestion.map((s) => ({ variantId: s.variantId, qty: s.qty, name: s.label }))} dashed />
                  {low && <Badge tone="amber" className="ml-1.5">check</Badge>}
                </div>
              ) : (
                <span className="text-amber">No suggestion — pick the items it contains.</span>
              )}
            </div>
          )}
        </div>
        {!editing && (
          <div className="flex gap-1.5">
            {pending(v) && v.suggestion.length > 0 && (
              <Button
                size="sm"
                variant="soft"
                loading={busy}
                onClick={() => onSave([{ variantId: v.variantId, components: v.suggestion.map((s) => ({ variantId: s.variantId, qty: s.qty })) }], "Recipe saved")}
              >
                Accept
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={startEdit}>
              {v.components ? "Edit" : v.notBundle ? "Make bundle" : "Edit"}
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-2 space-y-2 rounded-xl bg-surface-2 p-2.5">
          {editing.length === 0 && <div className="text-xs text-fg-muted">Add the single items one of this bundle uses.</div>}
          {editing.map((c, i) => (
            <div key={c.variantId} className="flex items-center gap-2 rounded-lg bg-surface p-1.5 ring-1 ring-line">
              <div className="flex items-center rounded-lg ring-1 ring-inset ring-line">
                <button className="grid size-8 place-items-center" onClick={() => setEditing(editing.map((x, j) => (j === i ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} aria-label="Less">
                  <IconMinus className="size-3.5" />
                </button>
                <span className="w-6 text-center text-sm font-semibold tabular-nums">{c.qty}</span>
                <button className="grid size-8 place-items-center" onClick={() => setEditing(editing.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)))} aria-label="More">
                  <IconPlus className="size-3.5" />
                </button>
              </div>
              <span className="min-w-0 flex-1 text-sm"><bdi>{names.get(c.variantId) ?? c.name}</bdi></span>
              <button className="p-1 text-fg-subtle hover:text-fg" onClick={() => setEditing(editing.filter((_, j) => j !== i))} aria-label="Remove">
                <IconX className="size-4" />
              </button>
            </div>
          ))}
          <ProductPicker
            items={singles}
            placeholder="Add an item…"
            onPick={(p) =>
              setEditing((cur) =>
                cur!.some((x) => x.variantId === p.id)
                  ? cur!.map((x) => (x.variantId === p.id ? { ...x, qty: x.qty + 1 } : x))
                  : [...cur!, { variantId: p.id, qty: 1, name: p.name }],
              )
            }
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={editing.length === 0}
              onClick={() => {
                onSave([{ variantId: v.variantId, components: editing.map((c) => ({ variantId: c.variantId, qty: c.qty })) }], "Recipe saved");
                setEditing(null);
              }}
            >
              Save recipe
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            {(v.components || v.notBundle) && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-pink"
                onClick={() => {
                  onSave([{ variantId: v.variantId, components: [] }], "Marked as not a bundle");
                  setEditing(null);
                }}
              >
                Not a bundle
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Recipe({ items, dashed }: { items: (Component & { name: string })[]; dashed?: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5 align-middle">
      {items.map((c) => (
        <span
          key={c.variantId}
          className={`rounded-lg px-2 py-0.5 text-xs ${dashed ? "border border-dashed border-line-strong text-fg-muted" : "bg-neon/10 text-neon"}`}
        >
          <b>{c.qty}×</b> <bdi>{c.name}</bdi>
        </span>
      ))}
    </span>
  );
}
