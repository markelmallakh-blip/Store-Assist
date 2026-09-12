"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { DashboardData } from "@/lib/dashboard";
import type { ConfirmationItem, ConfirmationState, ToBuyItem } from "@/lib/types";
import { IconAlert, IconCart, IconChat, IconCheck, IconExternal, IconMinus, IconPlus, IconSend, IconWallet, IconX } from "@/components/icons";
import { ProductPicker, type PickerItem } from "@/components/product-picker";
import {
  ageInDays,
  api,
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  LinkButton,
  money,
  PageHeader,
  qty,
  Skeleton,
  Thumb,
  timeAgo,
  useApi,
  useToast,
} from "@/components/ui";

export default function TodayPage() {
  const { data, error, loading, reload, setData } = useApi<DashboardData>("/api/dashboard");
  const toast = useToast();

  const [adding, setAdding] = useState(false);
  const needNow = data?.toBuy.filter((i) => i.forOpenOrders || i.manual.length) ?? [];
  const belowZero = data?.toBuy.filter((i) => !i.forOpenOrders && !i.manual.length) ?? [];

  async function removeManual(id: string) {
    try {
      await api("/api/manual-needs", { json: { action: "remove", id } });
      toast.show("Removed from To buy");
      reload();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "err");
    }
  }

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={data ? `Updated ${timeAgo(data.generatedAt)} · ${data.openOrders} open orders` : "Loading…"}
        onRefresh={reload}
        loading={loading}
      />

      {error && <ErrorBox message={error} onRetry={reload} />}
      {!data && loading && <Skeleton rows={4} />}

      {data && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
            <Stat label="To buy" value={needNow.length} tone={needNow.length ? "red" : "green"} href="#to-buy" />
            <Stat
              label="To confirm"
              value={data.confirmations.filter((c) => c.state !== "sent").length}
              tone={data.confirmations.some((c) => c.state === "not_sent") ? "red" : "green"}
              href="#confirm"
            />
            <Stat label="Awaiting reply" value={data.confirmations.filter((c) => c.state === "sent").length} tone="amber" href="#confirm" />
            <Stat
              label="EGP to settle"
              value={data.settlements.open.reduce((sum, p) => sum + p.owed, 0)}
              tone={data.settlements.open.length ? "violet" : "green"}
              href="#settlements"
            />
          </div>

          {!data.sheet.enabled && (
            <div className="mb-4 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-fg-muted">
              <b className="text-fg">Actual inventory sheet not connected yet.</b> To Buy uses Shopify stock only for now.{" "}
              <Link className="text-neon underline" href="/settings">
                Connect it
              </Link>
            </div>
          )}
          {data.sheet.enabled && !data.sheet.ok && <ErrorBox message={`Inventory sheet: ${data.sheet.error}`} />}

          {data.unmappedBundles.length > 0 && (
            <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber/30 bg-amber/10 p-4 text-sm text-amber">
              <IconAlert className="mt-0.5 size-5 text-amber" />
              <div className="flex-1">
                <b>{data.unmappedBundles.length} bundle{data.unmappedBundles.length > 1 ? "s" : ""} in open orders without a recipe</b>, so their single items
                aren&apos;t counted:{" "}
                {data.unmappedBundles.map((b, i) => (
                  <span key={b.variantId}>
                    {i > 0 && "; "}
                    <bdi>{b.name}</bdi> ({b.orders.join(", ")})
                  </span>
                ))}
                .{" "}
                <Link href="/bundles" className="font-medium underline">
                  Set up bundles
                </Link>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
            <section id="to-buy" className="min-w-0 scroll-mt-20">
              <SectionTitle icon={<IconCart className="size-5 text-neon" />} title="To buy" count={needNow.length}>
                {!adding && (
                  <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                    <IconPlus className="size-4" /> Add
                  </Button>
                )}
              </SectionTitle>
              {adding && (
                <AddNeedForm
                  onCancel={() => setAdding(false)}
                  onAdded={(name) => {
                    setAdding(false);
                    toast.show(`Added ${name} to To buy`);
                    reload();
                  }}
                  onError={(m) => toast.show(m, "err")}
                />
              )}
              {needNow.length === 0 ? (
                <Empty title="Nothing to buy for open orders">Every open order is covered by stock. Use “Add” for anything else you need.</Empty>
              ) : (
                <div className="space-y-2.5">
                  {needNow.map((item) => (
                    <ToBuyCard key={item.variantId} item={item} sheetOn={data.sheet.ok} onRemoveManual={removeManual} />
                  ))}
                </div>
              )}
              {belowZero.length > 0 && (
                <details className="mt-4 rounded-2xl border border-line bg-surface">
                  <summary className="cursor-pointer list-none px-4 py-3 text-sm">
                    <span className="font-medium">Stock below zero, no open orders</span>{" "}
                    <Badge tone="stone">{belowZero.length}</Badge>
                    <div className="mt-0.5 text-xs text-fg-muted">Past orders were shipped without stock being added back. Buy these or correct the count.</div>
                  </summary>
                  <div className="space-y-2 border-t border-line p-3">
                    {belowZero.map((item) => (
                      <ToBuyCard key={item.variantId} item={item} sheetOn={data.sheet.ok} onRemoveManual={removeManual} compact />
                    ))}
                  </div>
                </details>
              )}
            </section>

            <section id="confirm" className="min-w-0 scroll-mt-20">
              <Confirmations
                items={data.confirmations}
                sentTag={data.sentTag}
                onChanged={(orderId, change) => {
                  setData((d) =>
                    d
                      ? {
                          ...d,
                          confirmations:
                            change === "confirmed"
                              ? d.confirmations.filter((c) => c.orderId !== orderId)
                              : d.confirmations.map((c) => (c.orderId === orderId ? { ...c, state: "sent" as const } : c)),
                        }
                      : d,
                  );
                  toast.show(change === "confirmed" ? "Marked as confirmed" : "Marked as sent");
                }}
                onError={(m) => toast.show(m, "err")}
              />
            </section>
          </div>

          <section id="settlements" className="mt-8 scroll-mt-20">
            <Settlements
              data={data.settlements}
              onDone={(msg) => {
                toast.show(msg);
                reload();
              }}
              onError={(m) => toast.show(m, "err")}
            />
          </section>
        </>
      )}
      {toast.node}
    </>
  );
}

function Stat({ label, value, tone, href }: { label: string; value: number; tone: "red" | "green" | "amber" | "violet"; href: string }) {
  const color = { red: "text-pink text-glow-pink", green: "text-green text-glow-green", amber: "text-amber text-glow-amber", violet: "text-violet" }[tone];
  const edge = { red: "before:bg-pink", green: "before:bg-green", amber: "before:bg-amber", violet: "before:bg-violet" }[tone];
  return (
    <a
      href={href}
      className={`relative overflow-hidden rounded-2xl border border-line bg-surface px-3 py-3 transition hover:border-line-strong before:absolute before:inset-x-3 before:top-0 before:h-px before:opacity-70 sm:px-4 ${edge}`}
    >
      <div className={`text-2xl font-semibold tabular-nums sm:text-3xl ${color}`}>{value.toLocaleString("en-EG")}</div>
      <div className="text-xs text-fg-muted sm:text-sm">{label}</div>
    </a>
  );
}

function SectionTitle({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      {icon}
      <h2 className="text-lg font-semibold">{title}</h2>
      <Badge tone={count ? "accent" : "stone"}>{count}</Badge>
      <div className="ml-auto">{children}</div>
    </div>
  );
}

function ToBuyCard({
  item,
  sheetOn,
  compact,
  onRemoveManual,
}: {
  item: ToBuyItem;
  sheetOn: boolean;
  compact?: boolean;
  onRemoveManual: (id: string) => void;
}) {
  const orders = new Map<string, { legacyId: string; qty: number; via: string | null }>();
  for (const o of item.orders) {
    const prev = orders.get(o.name);
    orders.set(o.name, { legacyId: o.legacyId, qty: (prev?.qty ?? 0) + o.qty, via: prev?.via ?? o.viaBundle });
  }
  return (
    <Card className={compact ? "p-3" : "p-3.5"}>
      <div className="flex gap-3">
        <Thumb src={item.image} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div dir="auto" className="min-w-0 flex-1 text-start text-sm font-medium leading-snug">
              {item.name}
            </div>
            <div className="shrink-0 rounded-lg bg-pink/10 px-2 py-1 text-center text-pink ring-1 ring-pink/60 glow-pink">
              <div className="text-[10px] uppercase leading-none opacity-80">Buy</div>
              <div className="text-lg font-semibold leading-tight tabular-nums">{item.need}</div>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-muted">
            <span>
              Shopify <b className={item.shopifyQty < 0 ? "text-pink" : "text-fg"}>{item.shopifyQty}</b>
            </span>
            {sheetOn && (
              <span>
                Actual <b className={(item.actualQty ?? 0) < 0 ? "text-pink" : "text-fg"}>{qty(item.actualQty)}</b>
              </span>
            )}
            {item.cost != null && <span>Cost {money(item.cost)}</span>}
          </div>
          {!compact && item.reasons.length > 0 && <div className="mt-1 text-xs text-fg-muted">{item.reasons.join(" · ")}</div>}
          {item.manual.length > 0 && (
            <div className="mt-2 space-y-1">
              {item.manual.map((m) => (
                <div key={m.id} className="flex items-center gap-2 rounded-lg bg-violet/10 px-2 py-1 text-xs text-violet ring-1 ring-inset ring-violet/30">
                  <span className="font-medium">Added manually · +{m.qty}</span>
                  <span className="min-w-0 flex-1 truncate text-violet/75">
                    {m.note ? `“${m.note}” · ` : ""}
                    {timeAgo(m.addedAt)}
                  </span>
                  <button onClick={() => onRemoveManual(m.id)} className="rounded p-0.5 hover:bg-violet/20" aria-label="Remove manual need">
                    <IconX className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {orders.size > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[...orders.entries()].map(([name, o]) => (
                <Badge key={name} tone={o.via ? "blue" : "stone"}>
                  {name} × {o.qty}
                  {o.via ? " · bundle" : ""}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
      {!compact && (
        <div className="mt-3 flex justify-end">
          <Link
            href={`/purchase?variant=${encodeURIComponent(item.variantId)}&qty=${item.need}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-neon/10 px-3 text-xs font-medium text-neon ring-1 ring-inset ring-neon/30 hover:bg-neon/20"
          >
            <IconCart className="size-4" /> Record purchase
          </Link>
        </div>
      )}
    </Card>
  );
}

type SettlementsData = DashboardData["settlements"];
type OpenSettlement = SettlementsData["open"][number];
type SettledPurchase = SettlementsData["settled"][number];

const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Money Cupcairo owes each team member for purchases they paid, until it's marked settled. */
function Settlements({ data, onDone, onError }: { data: SettlementsData; onDone: (msg: string) => void; onError: (m: string) => void }) {
  const totalOwed = data.open.reduce((s, p) => s + p.owed, 0);
  return (
    <>
      <SectionTitle icon={<IconWallet className="size-5 text-violet" />} title="Settlements" count={data.open.reduce((n, p) => n + p.purchases.length, 0)}>
        <Link href="/purchase" className="text-xs font-medium text-fg-muted hover:text-fg">
          Purchase log →
        </Link>
      </SectionTitle>
      {data.error && <ErrorBox message={data.error} />}
      {!data.error && data.open.length === 0 && (
        <Empty title="Nothing to settle">When someone pays for a purchase from their own money, it shows up here until it&apos;s paid back.</Empty>
      )}
      {data.open.length > 0 && (
        <p className="mb-3 text-sm text-fg-muted">
          Cupcairo owes <b className="text-violet">{money(totalOwed)}</b> in total.
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {data.open.map((person) => (
          <PersonSettlement key={person.person} person={person} today={data.today} onDone={onDone} onError={onError} />
        ))}
      </div>
      {data.settled.length > 0 && (
        <details className="mt-4 rounded-2xl border border-line bg-surface">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm">
            <span className="font-medium">Settled</span> <Badge tone="stone">{data.settled.length}</Badge>
            <span className="ml-2 text-xs text-fg-muted">{money(data.settled.reduce((s, p) => s + p.total, 0))} paid back · newest first</span>
          </summary>
          <div className="divide-y divide-line border-t border-line">
            {data.settled.map((p) => (
              <SettledRow key={p.id} p={p} onDone={onDone} onError={onError} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function PersonSettlement({ person, today, onDone, onError }: { person: OpenSettlement; today: string; onDone: (m: string) => void; onError: (m: string) => void }) {
  // Which purchase is being settled ("all" = every open one for this person).
  const [settling, setSettling] = useState<string | null>(null);
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);

  const targets = settling === "all" ? person.purchases : person.purchases.filter((p) => p.id === settling);
  const minDate = targets.reduce((m, p) => (p.purchasedOn > m ? p.purchasedOn : m), "0000-00-00");

  async function confirm() {
    setBusy(true);
    try {
      await api("/api/purchases", { json: { ids: targets.map((p) => p.id), settledOn: date } });
      const amount = targets.reduce((s, p) => s + p.total, 0);
      onDone(`Settled ${money(amount)} with ${person.person} on ${shortDate(date)}`);
      setSettling(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const start = (key: string) => {
    setSettling(key);
    const t = key === "all" ? person.purchases : person.purchases.filter((p) => p.id === key);
    const earliestAllowed = t.reduce((m, p) => (p.purchasedOn > m ? p.purchasedOn : m), "0000-00-00");
    setDate(today < earliestAllowed ? earliestAllowed : today);
  };

  const picker = (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl bg-surface-2 p-2.5 ring-1 ring-inset ring-violet/30">
      <div>
        <label htmlFor={`settle-${person.person}-${settling}`} className="mb-1 block text-[11px] font-medium text-fg-muted">
          Settled on ({shortDate(minDate)} – today)
        </label>
        <input
          id={`settle-${person.person}-${settling}`}
          type="date"
          value={date}
          min={minDate}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          className="h-10 rounded-lg bg-surface px-3 text-sm ring-1 ring-inset ring-line-strong outline-none [color-scheme:dark] focus:ring-2 focus:ring-neon"
        />
      </div>
      <Button size="sm" variant="primary" loading={busy} disabled={!date || date < minDate || date > today} onClick={confirm} className="h-10">
        Confirm {money(targets.reduce((s, p) => s + p.total, 0))}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setSettling(null)} className="h-10">
        Cancel
      </Button>
    </div>
  );

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-violet/15 font-semibold text-violet ring-1 ring-violet/40">
          {person.person.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{person.person}</div>
          <div className="text-xs text-fg-muted">
            {person.purchases.length} purchase{person.purchases.length === 1 ? "" : "s"} paid from their money
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums text-violet">{money(person.owed)}</div>
          <div className="text-[11px] text-fg-muted">owed by Cupcairo</div>
        </div>
      </div>
      <div className="mt-3 divide-y divide-line rounded-xl ring-1 ring-inset ring-line">
        {person.purchases.map((p) => (
          <div key={p.id} className="px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs tabular-nums text-fg-muted">{shortDate(p.purchasedOn)}</span>
              <span className="min-w-0 flex-1 truncate text-sm">
                <bdi>{p.items.map((i) => `${i.qty}× ${i.name}`).join(", ") || "Purchase"}</bdi>
              </span>
              {p.receiptUrl && (
                <a href={p.receiptUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-cyan underline">
                  Receipt
                </a>
              )}
              <span className="shrink-0 text-sm font-medium tabular-nums">{money(p.total)}</span>
              {settling !== p.id && settling !== "all" && (
                <Button size="sm" variant="soft" onClick={() => start(p.id)}>
                  Settle
                </Button>
              )}
            </div>
            {settling === p.id && picker}
          </div>
        ))}
      </div>
      {person.purchases.length > 1 && (
        <div className="mt-3">
          {settling === "all" ? (
            picker
          ) : (
            <Button size="sm" variant="secondary" onClick={() => start("all")} disabled={settling !== null}>
              Settle all {money(person.owed)}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function SettledRow({ p, onDone, onError }: { p: SettledPurchase; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function undo() {
    setBusy(true);
    try {
      await api("/api/purchases", { json: { ids: [p.id], settledOn: null } });
      onDone(`Moved back to not settled`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
      <Badge tone="violet">{p.paidBy}</Badge>
      <span className="min-w-0 flex-1 truncate text-fg-muted">
        Bought {shortDate(p.purchasedOn)} · settled {shortDate(p.settledOn!)}
      </span>
      <span className="tabular-nums">{money(p.total)}</span>
      <Button size="sm" variant="ghost" loading={busy} onClick={undo}>
        Undo
      </Button>
    </div>
  );
}

type CatalogItem = PickerItem & { shopifyQty: number };

/** "+ Add" on To buy: pick a product, how many, and an optional note. */
function AddNeedForm({ onCancel, onAdded, onError }: { onCancel: () => void; onAdded: (name: string) => void; onError: (m: string) => void }) {
  const { data, loading } = useApi<{ items: CatalogItem[] }>("/api/catalog");
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [count, setCount] = useState(1);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!item) return;
    setSaving(true);
    try {
      await api("/api/manual-needs", { json: { action: "add", variantId: item.id, qty: count, note } });
      onAdded(item.name);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Card className="mb-3 p-3.5 ring-2 ring-violet/40">
      <div className="mb-2 text-sm font-medium">Add something to buy</div>
      {!item ? (
        <ProductPicker
          items={data?.items ?? []}
          autoFocus
          placeholder={loading ? "Loading products…" : "Search product or SKU…"}
          onPick={(p) => setItem(p as CatalogItem)}
        />
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-surface-2 p-2">
          <Thumb src={item.image} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium leading-snug">
              <bdi>{item.name}</bdi>
            </div>
            <div className="text-xs text-fg-muted">Shopify now {item.shopifyQty}</div>
          </div>
          <button onClick={() => setItem(null)} className="text-xs font-medium text-fg-muted underline">
            Change
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-fg-muted">Quantity</div>
          <div className="flex items-center rounded-xl ring-1 ring-inset ring-line-strong">
            <button className="grid size-10 place-items-center text-fg-muted" onClick={() => setCount((c) => Math.max(1, c - 1))} aria-label="Less">
              <IconMinus className="size-4" />
            </button>
            <input
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(Math.max(1, Number.parseInt(e.target.value.replace(/\D/g, "") || "1", 10)))}
              className="h-10 w-12 bg-transparent text-center font-semibold tabular-nums outline-none"
            />
            <button className="grid size-10 place-items-center text-fg-muted" onClick={() => setCount((c) => c + 1)} aria-label="More">
              <IconPlus className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-w-40 flex-1">
          <div className="mb-1 text-xs text-fg-muted">Note (optional)</div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. running low, customer asked"
            className="h-10 w-full rounded-xl px-3 text-sm bg-surface-2 ring-1 ring-inset ring-line-strong outline-none focus:ring-2 focus:ring-neon"
          />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!item} loading={saving} onClick={save}>
          Add to To buy
        </Button>
      </div>
    </Card>
  );
}

const STATE_LABEL: Record<ConfirmationState, { label: string; tone: "red" | "amber" | "stone" }> = {
  not_sent: { label: "Not sent", tone: "red" },
  sent: { label: "Sent · waiting", tone: "amber" },
  declined: { label: "Marked not confirmed", tone: "stone" },
};

function Confirmations({
  items,
  sentTag,
  onChanged,
  onError,
}: {
  items: ConfirmationItem[];
  sentTag: string;
  onChanged: (orderId: string, change: "confirmed" | "sent") => void;
  onError: (m: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | ConfirmationState>("all");
  const shown = useMemo(() => items.filter((i) => filter === "all" || i.state === filter), [items, filter]);
  const counts = {
    all: items.length,
    not_sent: items.filter((i) => i.state === "not_sent").length,
    sent: items.filter((i) => i.state === "sent").length,
    declined: items.filter((i) => i.state === "declined").length,
  };

  return (
    <>
      <SectionTitle icon={<IconSend className="size-5 text-neon" />} title="Confirmations" count={counts.not_sent + counts.declined} />
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {(["all", "not_sent", "sent", "declined"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition ${
              filter === f ? "bg-neon text-neon-ink ring-neon glow-neon" : "bg-surface text-fg-muted ring-line"
            }`}
          >
            {f === "all" ? "All" : STATE_LABEL[f].label} · {counts[f]}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <Empty title={items.length ? "Nothing in this filter" : "All open orders are confirmed"} />
      ) : (
        <div className="space-y-2.5">
          {shown.map((c) => (
            <ConfirmationCard key={c.orderId} c={c} sentTag={sentTag} onChanged={onChanged} onError={onError} />
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-fg-muted">
        Shown: open orders where <code className="rounded bg-surface-3 px-1">custom.confirmed</code> isn&apos;t true. &quot;Sent&quot; = order tagged{" "}
        <code className="rounded bg-surface-3 px-1">{sentTag}</code>.
      </p>
    </>
  );
}

function ConfirmationCard({
  c,
  onChanged,
  onError,
}: {
  c: ConfirmationItem;
  sentTag: string;
  onChanged: (orderId: string, change: "confirmed" | "sent") => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<"confirm" | "sent" | null>(null);
  const run = async (kind: "confirm" | "sent") => {
    setBusy(kind);
    try {
      await api(kind === "confirm" ? "/api/orders/confirm" : "/api/orders/sent", { json: { orderId: c.orderId } });
      onChanged(c.orderId, kind === "confirm" ? "confirmed" : "sent");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const s = STATE_LABEL[c.state];
  const ageDays = ageInDays(c.createdAt);

  return (
    <Card className="p-3.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a href={c.adminUrl} target="_blank" rel="noreferrer" className="font-semibold hover:underline">
              {c.name}
            </a>
            <Badge tone={s.tone}>{s.label}</Badge>
            {c.sourceName === "shopify_draft_order" && <Badge tone="stone">Backend</Badge>}
            {c.fulfillmentStatus !== "UNFULFILLED" && <Badge tone="stone">{c.fulfillmentStatus.replace(/_/g, " ").toLowerCase()}</Badge>}
          </div>
          <div className="mt-0.5 text-sm text-fg-muted">
            {c.customerName ?? "Customer"} · {money(c.total)}
          </div>
        </div>
        <div className={`shrink-0 text-xs ${ageDays > 2 ? "font-medium text-pink" : "text-fg-muted"}`}>{timeAgo(c.createdAt)}</div>
      </div>
      <div dir="auto" className="mt-1.5 line-clamp-2 text-start text-xs text-fg-muted">
        {c.itemsSummary}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {c.whatsapp && (
          <LinkButton href={`https://wa.me/${c.whatsapp}`} external className="text-green ring-green/40">
            <IconChat className="size-4" /> WhatsApp
          </LinkButton>
        )}
        <LinkButton href={c.adminUrl} external>
          <IconExternal className="size-4" /> Shopify
        </LinkButton>
        <div className="ml-auto flex gap-2">
          {c.state === "not_sent" && (
            <Button size="sm" variant="secondary" loading={busy === "sent"} onClick={() => run("sent")}>
              <IconSend className="size-4" /> Mark sent
            </Button>
          )}
          <Button size="sm" variant="success" loading={busy === "confirm"} onClick={() => run("confirm")}>
            <IconCheck className="size-4" /> Confirmed
          </Button>
        </div>
      </div>
    </Card>
  );
}
