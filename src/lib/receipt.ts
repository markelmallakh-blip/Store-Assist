import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "@/lib/config";
import { looksLikeBundle } from "@/lib/bundles";
import type { Variant } from "@/lib/types";

const ReadingSchema = z.object({
  kind: z.enum(["receipt", "product_photo", "other"]),
  store_name: z.string().nullable(),
  lines: z.array(
    z.object({
      text: z.string().describe("The item exactly as printed on the receipt, or what the photographed product is"),
      quantity: z.number().nullable().describe("Units bought. null if not visible"),
      unit_price: z.number().nullable().describe("Price per unit in EGP. null if not visible"),
      line_total: z.number().nullable().describe("Line total in EGP. null if not visible"),
      barcode: z.string().nullable().describe("Barcode digits if readable, else null"),
      matches: z
        .array(
          z.object({
            ref: z.string().describe("Catalog ref like P12"),
            confidence: z.number().describe("0 to 1"),
          }),
        )
        .describe("Best catalog matches, most likely first. Empty if nothing fits"),
    }),
  ),
});

export type PurchaseCandidate = { variantId: string; name: string; image: string | null; confidence: number; cost: number | null };
export type PurchaseLine = {
  text: string;
  quantity: number | null;
  unitPrice: number | null;
  candidates: PurchaseCandidate[];
};
export type PurchaseReading = { kind: string; storeName: string | null; lines: PurchaseLine[] };

const SYSTEM_INSTRUCTIONS = `You help the team of Cupcairo, an online grocery store in Egypt (coffee, capsules, spreads, snacks), record stock they just bought.

You receive one or more photos. Each photo is either a supplier receipt/invoice (often Arabic, prices in EGP) or a photo of the products themselves.

For a receipt: return one line per purchased item with the quantity, unit price and line total as printed. Skip totals, taxes, discounts, and payment lines. If only the line total is printed, still return it; if the quantity is printed as a weight, put the number as printed.
For product photos: return one line per distinct product visible, with the quantity you can count (null if unclear) and no prices.

Then match each line to the store catalog below using its ref (P1, P2, ...). Brand, flavour/variant, size/weight and pack type (capsules vs ground vs beans, can vs vacuum pack) all matter. Arabic receipt names often abbreviate brand and flavour. When several catalog items could fit, list up to 4 in order of likelihood with honest confidences so a person can choose. Give confidence 0.9+ only when brand, flavour and size clearly agree. Never invent refs.

CATALOG (ref | product | SKU/barcode | brand | type):`;

function catalogBlock(items: Variant[]) {
  return items
    .map((v, i) => `P${i + 1} | ${v.name} | ${v.sku ?? v.barcode ?? "-"} | ${v.vendor || "-"} | ${v.productType || "-"}`)
    .join("\n");
}

/** Products that can be bought: everything that isn't a bundle. Stable order keeps the prompt cacheable. */
export function purchasableCatalog(catalog: Variant[]) {
  return catalog.filter((v) => !v.components && !looksLikeBundle(v)).sort((a, b) => a.id.localeCompare(b.id));
}

let client: Anthropic | null = null;

export async function readPurchasePhotos(
  images: { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" }[],
  catalog: Variant[],
): Promise<PurchaseReading> {
  const items = purchasableCatalog(catalog);
  const refs = new Map(items.map((v, i) => [`P${i + 1}`, v]));

  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: config.claude.model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: config.claude.effort, format: betaZodOutputFormat(ReadingSchema) },
    system: [
      {
        type: "text",
        text: `${SYSTEM_INSTRUCTIONS}\n${catalogBlock(items)}`,
        // The catalog rarely changes, so repeated scans reuse the cached prompt.
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
          })),
          { type: "text" as const, text: "Read these purchase photos and match them to the catalog." },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to read these photos. Try another photo.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Couldn't read the photos. Try a clearer photo.");

  const bySku = new Map<string, Variant>();
  for (const v of items) {
    if (v.sku) bySku.set(v.sku, v);
    if (v.barcode) bySku.set(v.barcode, v);
  }

  const lines: PurchaseLine[] = parsed.lines.map((l) => {
    const candidates: PurchaseCandidate[] = [];
    const push = (v: Variant | undefined, confidence: number) => {
      if (!v || candidates.some((c) => c.variantId === v.id)) return;
      candidates.push({ variantId: v.id, name: v.name, image: v.image, confidence, cost: v.cost });
    };
    // An exact barcode hit beats any name match.
    if (l.barcode) push(bySku.get(l.barcode.replace(/\D/g, "")), 1);
    for (const m of l.matches) push(refs.get(m.ref.trim().toUpperCase()), Math.max(0, Math.min(1, m.confidence)));

    const quantity = l.quantity && l.quantity > 0 ? l.quantity : null;
    let unitPrice = l.unit_price;
    if (unitPrice == null && l.line_total != null && quantity) unitPrice = Math.round((l.line_total / quantity) * 100) / 100;
    return { text: l.text, quantity, unitPrice, candidates: candidates.slice(0, 4) };
  });

  return { kind: parsed.kind, storeName: parsed.store_name, lines };
}
