"use client";

import { useMemo, useState } from "react";
import type { ProductsData } from "@/lib/dashboard";
import type { ProductRow } from "@/lib/types";
import { IconSearch } from "@/components/icons";
import { Badge, Card, Empty, ErrorBox, money, PageHeader, qty, Skeleton, Thumb, useApi } from "@/components/ui";

type Filter = "all" | "negative" | "mismatch" | "nosheet" | "nocost";

const norm = (s: string) => s.toLowerCase();

function margin(r: ProductRow) {
  if (r.cost == null || !r.price) return null;
  return Math.round(((r.price - r.cost) / r.price) * 100);
}

export default function ProductsPage() {
  const { data, error, loading, reload } = useApi<ProductsData>("/api/products");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [showDrafts, setShowDrafts] = useState(false);
  const sheetOn = Boolean(data?.sheet.ok);

  const rows = useMemo(() => {
    const words = norm(query).split(/\s+/).filter(Boolean);
    return (data?.products ?? []).filter((r) => {
      if (r.isBundle) return false;
      if (!showDrafts && r.status !== "ACTIVE") return false;
      if (words.length && !words.every((w) => norm(`${r.name} ${r.sku ?? ""} ${r.vendor}`).includes(w))) return false;
      switch (filter) {
        case "negative":
          return r.shopifyQty < 0 || (r.actualQty ?? 0) < 0;
        case "mismatch":
          return r.inSheet && r.actualQty !== r.shopifyQty;
        case "nosheet":
          return !r.inSheet;
        case "nocost":
          return r.cost == null;
        default:
          return true;
      }
    });
  }, [data, query, filter, showDrafts]);

  const filters: { id: Filter; label: string; needsSheet?: boolean }[] = [
    { id: "all", label: "All" },
    { id: "negative", label: "Below zero" },
    { id: "mismatch", label: "Shopify ≠ actual", needsSheet: true },
    { id: "nosheet", label: "Not in sheet", needsSheet: true },
    { id: "nocost", label: "No cost" },
  ];

  return (
    <>
      <PageHeader title="Products" subtitle={data ? `${rows.length} shown` : "Loading…"} onRefresh={reload} loading={loading} />
      {error && <ErrorBox message={error} onRetry={reload} />}
      {data?.sheet.enabled && !data.sheet.ok && <ErrorBox message={`Inventory sheet: ${data.sheet.error}`} />}

      <div className="mb-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 ring-1 ring-inset ring-line-strong focus-within:ring-2 focus-within:ring-neon">
        <IconSearch className="size-4 text-fg-subtle" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, SKU, brand…" className="h-11 w-full bg-transparent text-sm outline-none" />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {filters
          .filter((f) => !f.needsSheet || sheetOn)
          .map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${filter === f.id ? "bg-neon text-neon-ink ring-neon glow-neon" : "bg-surface text-fg-muted ring-line"}`}
            >
              {f.label}
            </button>
          ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={showDrafts} onChange={(e) => setShowDrafts(e.target.checked)} className="accent-[#c5ff3c]" />
          Show drafts
        </label>
      </div>

      {!data && loading && <Skeleton rows={6} />}
      {data && rows.length === 0 && <Empty title="No products match" />}

      {data && rows.length > 0 && (
        <>
          {/* Phone: cards */}
          <div className="space-y-2 md:hidden">
            {rows.map((r) => (
              <Card key={r.variantId} className="p-3">
                <div className="flex gap-3">
                  <Thumb src={r.image} />
                  <div className="min-w-0 flex-1">
                    <a href={r.adminUrl} target="_blank" rel="noreferrer" className="text-sm font-medium leading-snug">
                      <bdi>{r.name}</bdi>
                    </a>
                    <div className="text-xs text-fg-muted">{r.sku ?? "no SKU"}</div>
                  </div>
                </div>
                <div className="mt-2.5 grid grid-cols-4 gap-2 text-center">
                  <Metric label="Shopify" value={qty(r.shopifyQty)} bad={r.shopifyQty < 0} />
                  <Metric label="Actual" value={sheetOn ? (r.inSheet ? qty(r.actualQty) : "—") : "n/a"} bad={(r.actualQty ?? 0) < 0} warn={r.inSheet && r.actualQty !== r.shopifyQty} />
                  <Metric label="Cost" value={r.cost != null ? String(r.cost) : "—"} />
                  <Metric label="Price" value={String(r.price)} sub={margin(r) != null ? `${margin(r)}%` : undefined} />
                </div>
              </Card>
            ))}
          </div>

          {/* Desktop: table */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-fg-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Product</th>
                    <th className="px-3 py-2.5 text-right font-medium">Shopify</th>
                    <th className="px-3 py-2.5 text-right font-medium">Actual</th>
                    <th className="px-3 py-2.5 text-right font-medium">Cost</th>
                    <th className="px-3 py-2.5 text-right font-medium">Price</th>
                    <th className="px-4 py-2.5 text-right font-medium">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r) => {
                    const m = margin(r);
                    const mismatch = r.inSheet && r.actualQty !== r.shopifyQty;
                    return (
                      <tr key={r.variantId} className="hover:bg-surface-2/60">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-3">
                            <Thumb src={r.image} />
                            <div className="min-w-0">
                              <a href={r.adminUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                                <bdi>{r.name}</bdi>
                              </a>
                              <div className="flex gap-2 text-xs text-fg-muted">
                                <span>{r.sku ?? "no SKU"}</span>
                                {r.status !== "ACTIVE" && <Badge tone="stone">{r.status.toLowerCase()}</Badge>}
                                {!r.tracked && <Badge tone="stone">not tracked</Badge>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${r.shopifyQty < 0 ? "font-semibold text-pink" : ""}`}>{r.shopifyQty}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${(r.actualQty ?? 0) < 0 ? "font-semibold text-pink" : mismatch ? "font-semibold text-amber" : ""}`}>
                          {sheetOn ? (r.inSheet ? qty(r.actualQty) : <span className="text-fg-subtle">not in sheet</span>) : <span className="text-fg-subtle">n/a</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(r.cost)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(r.price)}</td>
                        <td className={`px-4 py-2 text-right tabular-nums ${m != null && m < 10 ? "text-pink" : "text-fg-muted"}`}>{m != null ? `${m}%` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

function Metric({ label, value, sub, bad, warn }: { label: string; value: string; sub?: string; bad?: boolean; warn?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 py-1.5">
      <div className={`text-sm font-semibold tabular-nums ${bad ? "text-pink" : warn ? "text-amber" : ""}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-fg-muted">
        {label}
        {sub ? ` · ${sub}` : ""}
      </div>
    </div>
  );
}
