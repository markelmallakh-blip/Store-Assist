"use client";

import { useMemo, useRef, useState } from "react";
import { IconSearch } from "./icons";
import { Thumb } from "./ui";

export type PickerItem = { id: string; name: string; image: string | null; sku: string | null; status?: string };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export function filterItems(items: PickerItem[], query: string, limit = 8) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return items
    .filter((i) => {
      const hay = norm(`${i.name} ${i.sku ?? ""}`);
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE"))
    .slice(0, limit);
}

/** Search box that picks one product from a list. */
export function ProductPicker({
  items,
  onPick,
  placeholder = "Search product or SKU…",
  autoFocus,
}: {
  items: PickerItem[];
  onPick: (item: PickerItem) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterItems(items, query), [items, query]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 ring-1 ring-inset ring-line-strong focus-within:ring-2 focus-within:ring-neon">
        <IconSearch className="size-4 text-fg-subtle" />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-fg-subtle"
        />
      </div>
      {open && query && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-auto rounded-xl border border-line bg-surface p-1 shadow-lg">
          {results.length === 0 && <div className="px-3 py-2 text-sm text-fg-muted">No match</div>}
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(r);
                setQuery("");
                setOpen(false);
                inputRef.current?.blur();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
            >
              <Thumb src={r.image} />
              <div className="min-w-0">
                <div className="truncate text-sm"><bdi>{r.name}</bdi></div>
                <div className="text-xs text-fg-muted">
                  {r.sku ?? "no SKU"}
                  {r.status && r.status !== "ACTIVE" ? ` · ${r.status.toLowerCase()}` : ""}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
