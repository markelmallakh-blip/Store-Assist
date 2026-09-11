import type { Component, Variant } from "@/lib/types";

// ---------------------------------------------------------------------------
// Expanding bundles into the single items they consume
// ---------------------------------------------------------------------------

export type Expanded = { variantId: string; qty: number; viaBundle: string | null };

/**
 * Turn a sold variant into the single items it takes off the shelf.
 * A bundle with a saved recipe expands into its components (recursively, max 3 levels);
 * everything else is itself.
 */
export function expandVariant(
  variantId: string,
  qty: number,
  catalog: Map<string, Variant>,
  depth = 0,
  viaBundle: string | null = null,
): Expanded[] {
  const v = catalog.get(variantId);
  if (!v || !v.components || depth >= 3) return [{ variantId, qty, viaBundle }];
  return v.components.flatMap((c) => expandVariant(c.variantId, c.qty * qty, catalog, depth + 1, viaBundle ?? v.name));
}

/** Sum expanded lines per single variant. */
export function sumExpanded(lines: Expanded[]) {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.variantId, (out.get(l.variantId) ?? 0) + l.qty);
  return out;
}

// ---------------------------------------------------------------------------
// Detecting bundle-like products that still need a recipe
// ---------------------------------------------------------------------------

const MULTIPACK = /^\s*(\d{1,2})\s*(?:x\s+|jars?\s+(?:of\s+)?|packs?\s+(?:of\s+)?|pcs?\s+|pieces?\s+)?(?=\D)/i;
const BUNDLE_OF = /bundle\s+of\s+(\d{1,2})/i;
const DUO_TRIO = /\b(duo|trio)\b/i;

export function multipackCount(title: string): number | null {
  const m = title.match(MULTIPACK) ?? title.match(BUNDLE_OF);
  let n = m ? Number(m[1]) : NaN;
  if (!m) {
    const d = title.match(DUO_TRIO);
    if (d) n = d[1].toLowerCase() === "duo" ? 2 : 3;
  }
  return n >= 2 && n <= 24 ? n : null;
}

/** Option names that describe a choice of item, e.g. "Choose your first Davidoff". */
const isChoiceOption = (name: string) => /choose|pick|select|first|second|third|fourth|flavou?r|sleeve|weight|item/i.test(name);

/** Heuristic: does this look like a bundle whose stock really lives in other products? */
export function looksLikeBundle(v: Variant): boolean {
  if (v.components) return true;
  if (v.notBundle) return false;
  if (/bundles?/i.test(v.productType)) return true;
  if (/\bbundle\b|\bduo\b|\bbox\b/i.test(v.productTitle)) return true;
  if (multipackCount(v.productTitle)) return true;
  if (v.options.length > 0 && v.options.every((o) => /choose|pick|select|first|second|third/i.test(o.name))) return true;
  return false;
}

/** Bundles we can suggest a recipe for from the variant's options. */
function optionDriven(v: Variant) {
  return v.options.length > 0 && (/bundles?/i.test(v.productType) || v.options.every((o) => isChoiceOption(o.name)));
}

// ---------------------------------------------------------------------------
// Suggesting a recipe for a bundle variant
// ---------------------------------------------------------------------------

const STOP = new Set([
  "choose", "your", "the", "a", "an", "of", "and", "with", "from", "for", "pick", "select",
  "first", "second", "third", "fourth", "1st", "2nd", "3rd", "bundle", "build", "own", "flavor", "flavour",
  "option", "default", "title", "jar", "jars", "pack", "packs", "x",
]);

function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d)\s*(gm|g|gr|grams?|kg|ml|l)\b/g, "$1$2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}

type Indexed = { v: Variant; toks: Set<string>; joined: string };

function candidateTokens(v: Variant): Indexed {
  const list = tokens(`${v.productTitle} ${v.variantTitle ?? ""}`);
  const toks = new Set(list);
  // Also index adjacent pairs glued together ("e gusto" -> "egusto") to catch squashed option names.
  for (let i = 0; i < list.length - 1; i++) toks.add(list[i] + list[i + 1]);
  return { v, toks, joined: list.join(" ") };
}

function tokenHit(q: string, cand: Set<string>): number {
  if (cand.has(q)) return 1;
  if (q.length < 3) return 0;
  for (const c of cand) {
    if (c.length < 3) continue;
    // "mix" ~ "mixed", "egusto" ~ "gusto"
    if (c.startsWith(q) || q.startsWith(c)) return 0.7;
    if (q.length >= 4 && c.length >= 4 && (c.includes(q) || q.includes(c))) return 0.7;
  }
  return 0;
}

export type Suggestion = {
  variantId: string;
  qty: number;
  confidence: number;
  label: string;
  /** How it was found: same barcode, an option value, a part of an "A & B" title, or the title alone. */
  basis: "sku" | "options" | "parts" | "title";
};

/** Singles that can be bundle components: not bundles themselves, not multipacks. */
export function componentPool(catalog: Variant[]): Variant[] {
  return catalog.filter((v) => !looksLikeBundle(v));
}

function rankFor(
  query: string,
  pool: Indexed[],
  idf: Map<string, number>,
  bundle: Variant,
): { v: Variant; score: number }[] {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const weight = (t: string) => idf.get(t) ?? Math.log(pool.length + 1);
  const total = q.reduce((s, t) => s + weight(t), 0);
  return pool
    .map(({ v, toks }) => {
      let hit = 0;
      for (const t of q) hit += tokenHit(t, toks) * weight(t);
      let score = hit / total;
      if (score > 0) {
        if (v.vendor && v.vendor === bundle.vendor) score += 0.15;
        if (v.productType && v.productType === bundle.productType) score += 0.1;
        if (v.status === "ACTIVE") score += 0.05;
      }
      return { v, score };
    })
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score);
}

function buildIdf(pool: Indexed[]) {
  const df = new Map<string, number>();
  for (const p of pool) for (const t of p.toks) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log((pool.length + 1) / n) + 0.2);
  return idf;
}

/**
 * Propose a recipe for one bundle variant.
 * - Option-based bundles ("Rich Aroma / Espresso 57"): each option value -> best matching single.
 *   Repeated values add up (Rich Aroma / Rich Aroma -> 2x Rich Aroma).
 * - Multipacks ("2 Davidoff RICH AROMA", "Bundle of 2"): N x the single with the same SKU,
 *   or the best title match.
 */
export function suggestRecipe(bundle: Variant, catalog: Variant[]): Suggestion[] {
  const poolVariants = componentPool(catalog).filter((v) => v.productId !== bundle.productId);
  const pool = poolVariants.map(candidateTokens);
  const idf = buildIdf(pool);
  const picks = new Map<string, Suggestion>();

  const add = (v: Variant, qty: number, confidence: number, basis: Suggestion["basis"]) => {
    const prev = picks.get(v.id);
    if (prev) {
      prev.qty += qty;
      prev.confidence = Math.min(prev.confidence, confidence);
    } else {
      picks.set(v.id, { variantId: v.id, qty, confidence, label: v.name, basis });
    }
  };

  const choiceOptions = optionDriven(bundle)
    ? bundle.options.filter((o) => o.value && o.value.toLowerCase() !== "default title")
    : [];

  if (choiceOptions.length) {
    // Context words from the product title help ("Davidoff", "Capsules"), but the option value must match.
    const context = tokens(bundle.productTitle).filter((t) => !/^\d/.test(t)).join(" ");
    for (const opt of choiceOptions) {
      const nameHint = tokens(opt.name).join(" ");
      const valueRank = rankFor(opt.value, pool, idf, bundle);
      if (!valueRank.length) continue;
      // Re-rank the value matches using the option name + product title as a tie-breaker.
      const ctxRank = new Map(rankFor(`${opt.value} ${nameHint} ${context}`, pool, idf, bundle).map((r) => [r.v.id, r.score]));
      const best = valueRank
        .map((r) => ({ v: r.v, score: r.score + 0.5 * (ctxRank.get(r.v.id) ?? 0) }))
        .sort((a, b) => b.score - a.score);
      const top = best[0];
      const gap = best[1] ? top.score - best[1].score : 1;
      // A bare measure ("300 gm") matches many products; never treat it as certain.
      const cap = tokens(opt.value).every((t) => /^\d/.test(t)) ? 0.6 : 1;
      add(top.v, 1, Math.max(0, Math.min(cap, 0.45 + gap)), "options");
    }
    return [...picks.values()];
  }

  const count = multipackCount(bundle.productTitle) ?? 1;
  const stripped = bundle.productTitle.replace(MULTIPACK, "").replace(BUNDLE_OF, "").replace(DUO_TRIO, "");

  // "Davidoff FINE AROMA & RICH AROMA - Instant Coffee - 100g" -> two parts sharing the suffix.
  const [head, ...rest] = stripped.split(/\s[-–|]\s/);
  const suffix = rest.join(" ");
  const parts = head.split(/\s*(?:&|\+|\band\b|,)\s*/i).filter((p) => tokens(p).length);
  if (parts.length > 1 && count % parts.length === 0) {
    const brand = tokens(parts[0])[0] ?? "";
    for (const part of parts) {
      const query = `${part.toLowerCase().includes(brand) ? "" : brand} ${part} ${suffix}`;
      const ranked = rankFor(query, pool, idf, bundle);
      if (!ranked.length) continue;
      const gap = ranked[1] ? ranked[0].score - ranked[1].score : 1;
      add(ranked[0].v, count / parts.length, Math.max(0, Math.min(1, 0.4 + gap)), "parts");
    }
    if (picks.size) return [...picks.values()];
  }

  const ranked = rankFor(stripped, pool, idf, bundle);

  // "2 Jars El Mordjene … 700g" sharing its barcode with the single jar -> N x that single.
  // The name must agree too: copy-pasted SKUs exist (three different Illy bundles share one).
  if (bundle.sku) {
    const sameSku = poolVariants.filter((v) => v.sku === bundle.sku);
    if (sameSku.length === 1) {
      const skuScore = ranked.find((r) => r.v.id === sameSku[0].id)?.score ?? 0;
      if (ranked.length && ranked[0].score - skuScore <= 0.1) {
        add(sameSku[0], count, 0.95, "sku");
        return [...picks.values()];
      }
    }
  }

  if (ranked.length) {
    const gap = ranked[1] ? ranked[0].score - ranked[1].score : 1;
    add(ranked[0].v, count, Math.max(0, Math.min(1, 0.35 + gap)), "title");
  }
  return [...picks.values()];
}

/**
 * Recipes the dashboard applies on its own, without anyone pressing Accept:
 * - multipacks whose barcode AND name match one single ("2 Jars El Mordjene" -> 2x the jar)
 * - products of type "Bundles" whose every option clearly names one single (Davidoff Bundle)
 * Anything less certain waits for a person on the Bundles page.
 */
export function autoRecipe(bundle: Variant, catalog: Variant[]): Component[] | null {
  if (bundle.components || bundle.notBundle || !looksLikeBundle(bundle)) return null;
  const s = suggestRecipe(bundle, catalog);
  if (!s.length) return null;
  const confident =
    s.every((x) => x.basis === "sku") ||
    (/bundles?/i.test(bundle.productType) && s.every((x) => x.basis === "options" && x.confidence >= 0.9));
  return confident ? s.map((x) => ({ variantId: x.variantId, qty: x.qty })) : null;
}

/** Fill in automatic recipes on a freshly loaded catalog (saved recipes always win). */
export function withAutoRecipes(catalog: Variant[]): Variant[] {
  const autos = new Map<string, Component[]>();
  for (const v of catalog) {
    const recipe = autoRecipe(v, catalog);
    if (recipe) autos.set(v.id, recipe);
  }
  return catalog.map((v) => {
    const recipe = autos.get(v.id);
    return recipe ? { ...v, components: recipe, recipeSource: "auto" as const } : v;
  });
}

/** Top matches for a free-text search in the component picker / purchase screen. */
export function searchVariants(query: string, catalog: Variant[], limit = 8): Variant[] {
  const q = normalize(query);
  if (!q) return [];
  const words = q.split(" ");
  return catalog
    .map((v) => {
      const hay = normalize(`${v.name} ${v.sku ?? ""} ${v.barcode ?? ""} ${v.vendor}`);
      const hits = words.filter((w) => hay.includes(w)).length;
      return { v, score: hits / words.length + (hay.startsWith(q) ? 0.2 : 0) + (v.status === "ACTIVE" ? 0.05 : 0) };
    })
    .filter((r) => r.score >= 0.99)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.v);
}

export function recipeLabel(components: Component[], catalog: Map<string, Variant>) {
  return components.map((c) => `${c.qty}× ${catalog.get(c.variantId)?.name ?? "Unknown item"}`).join(" + ");
}
