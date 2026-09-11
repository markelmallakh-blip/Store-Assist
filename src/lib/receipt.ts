import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config, receiptProvider } from "@/lib/config";
import { canSaveLocally, writeEnvLocal } from "@/lib/env-file";
import { looksLikeBundle } from "@/lib/bundles";
import type { Variant } from "@/lib/types";

const ReadingSchema = z.object({
  kind: z.enum(["receipt", "product_photo", "other"]),
  store_name: z.string().nullable(),
  lines: z.array(
    z.object({
      text: z.string().describe("The item exactly as printed on the receipt (keep Arabic as Arabic), or what the photographed product is"),
      text_en: z.string().describe("The same item in English: brand in its usual Latin spelling, flavour/type, size (e.g. 'Davidoff Rich Aroma instant coffee 100g')"),
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
  /** English reading of the line (same as `text` when it was already English). */
  textEn: string;
  quantity: number | null;
  unitPrice: number | null;
  candidates: PurchaseCandidate[];
};
export type PurchaseReading = { kind: string; storeName: string | null; lines: PurchaseLine[] };

const SYSTEM_INSTRUCTIONS = `You help the team of Cupcairo, an online grocery store in Egypt (coffee, capsules, spreads, snacks), record stock they just bought.

You receive one or more photos. Each photo is either a supplier receipt/invoice (often Arabic, prices in EGP) or a photo of the products themselves.

For a receipt: return one line per purchased item with the quantity, unit price and line total as printed. Skip totals, taxes, discounts, and payment lines. If only the line total is printed, still return it; if the quantity is printed as a weight, put the number as printed.
For product photos: return one line per distinct product visible, with the quantity you can count (null if unclear) and no prices.

Receipts from Egyptian suppliers are usually in Arabic while the catalog is mostly in English (a few items, like Abu Auf Turkish coffee, have Arabic titles). For every line, read the Arabic, then write text_en: the English name with the brand in its usual Latin spelling. Arabic brand names are phonetic, e.g. دافيدوف = Davidoff, لافازا = Lavazza, نسكافيه / نسكافية = Nescafé, دولتشي جوستو = Dolce Gusto, إيلي / الي = illy, محمد أفندي = Mehmet Efendi, أبو عوف = Abu Auf, نوتيلا = Nutella, لوتس = Lotus, سيبون / مرجان = CEBON El Mordjene "Morgan", سبريتز = SPRITZ, سينو / تشينو = CCINO, ستاربكس = Starbucks. Common words: قهوة = coffee, سريعة الذوبان = instant, محمصة / مطحونة = roasted / ground, حبوب = beans, بن = coffee (usually ground), كبسولات = capsules, شوكولاتة = chocolate, صوص = sauce, فاتح = light, وسط = medium, غامق = dark, سادة = plain, محوج = spiced, جرام / جم = g, كيلو = kg, علبة = can/box, عبوة = pack. Receipts often abbreviate or misspell names; use the price and size to decide.

Then match each line to the store catalog below using its ref (P1, P2, ...), comparing the Arabic text and your English reading against both English and Arabic catalog titles. Brand, flavour/variant, size/weight and pack type (capsules vs ground vs beans, can vs vacuum pack) all matter. When several catalog items could fit, list up to 4 in order of likelihood with honest confidences so a person can choose. Give confidence 0.9+ only when brand, flavour and size clearly agree. Never invent refs.

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

/** Test a Claude API key, then use it right away (and save it to .env.local when running locally). */
export async function connectClaude(apiKey: string) {
  const key = apiKey.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
    throw new Error("That doesn't look like a Claude API key. It starts with sk-ant- (console.anthropic.com → API keys).");
  }
  try {
    await new Anthropic({ apiKey: key }).models.retrieve(config.claude.model);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Claude didn't accept this key. Copy it again from console.anthropic.com → API keys.");
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error("This key can't use the receipt model. Check the key's workspace in console.anthropic.com.");
    if (e instanceof Anthropic.NotFoundError) throw new Error(`The model ${config.claude.model} isn't available to this key.`);
    if (e instanceof Anthropic.APIError) throw new Error(`Claude answered ${e.status}: ${e.message}`);
    throw e;
  }
  process.env.ANTHROPIC_API_KEY = key;
  process.env.RECEIPT_AI = "claude";
  let saved = false;
  if (canSaveLocally()) {
    await writeEnvLocal({ ANTHROPIC_API_KEY: key, RECEIPT_AI: "claude" });
    saved = true;
  }
  return { ok: true, saved, model: config.claude.model };
}

/** Test an OpenAI API key (platform.openai.com), then use OpenAI for receipt reading. */
export async function connectOpenAI(apiKey: string) {
  const key = apiKey.trim();
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key) || key.startsWith("sk-ant-")) {
    throw new Error("That doesn't look like an OpenAI API key. It starts with sk- (platform.openai.com → API keys).");
  }
  try {
    await new OpenAI({ apiKey: key }).models.retrieve(config.openai.model);
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) throw new Error("OpenAI didn't accept this key. Copy it again from platform.openai.com → API keys.");
    if (e instanceof OpenAI.PermissionDeniedError) throw new Error("This key isn't allowed to use the model. Check the key's project permissions on platform.openai.com.");
    if (e instanceof OpenAI.NotFoundError) throw new Error(`The model ${config.openai.model} isn't available to this key.`);
    if (e instanceof OpenAI.APIError) throw new Error(`OpenAI answered ${e.status}: ${e.message}`);
    throw e;
  }
  process.env.OPENAI_API_KEY = key;
  process.env.RECEIPT_AI = "openai";
  let saved = false;
  if (canSaveLocally()) {
    await writeEnvLocal({ OPENAI_API_KEY: key, RECEIPT_AI: "openai" });
    saved = true;
  }
  return { ok: true, saved, model: config.openai.model };
}

type Reading = z.infer<typeof ReadingSchema>;
type Img = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };
const USER_TEXT = "Read these purchase photos (Arabic or English) and match every item to the catalog.";

async function readWithClaude(images: Img[], systemText: string): Promise<Reading> {
  // Created per call so a key saved from Settings takes effect immediately.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.parse({
    model: config.claude.model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: config.claude.effort, format: betaZodOutputFormat(ReadingSchema) },
    system: [
      {
        type: "text",
        text: systemText,
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
          { type: "text" as const, text: USER_TEXT },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to read these photos. Try another photo.");
  if (!response.parsed_output) throw new Error("Couldn't read the photos. Try a clearer photo.");
  return response.parsed_output;
}

async function readWithOpenAI(images: Img[], systemText: string): Promise<Reading> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.parse({
    model: config.openai.model,
    instructions: systemText,
    input: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({ type: "input_image" as const, image_url: `data:${img.mediaType};base64,${img.data}`, detail: "high" as const })),
          { type: "input_text" as const, text: USER_TEXT },
        ],
      },
    ],
    text: { format: zodTextFormat(ReadingSchema, "purchase_reading") },
  });
  if (!response.output_parsed) throw new Error("Couldn't read the photos. Try a clearer photo.");
  return response.output_parsed;
}

export async function readPurchasePhotos(
  images: Img[],
  catalog: Variant[],
): Promise<PurchaseReading> {
  const items = purchasableCatalog(catalog);
  const refs = new Map(items.map((v, i) => [`P${i + 1}`, v]));

  const systemText = `${SYSTEM_INSTRUCTIONS}\n${catalogBlock(items)}`;
  const parsed = receiptProvider() === "openai" ? await readWithOpenAI(images, systemText) : await readWithClaude(images, systemText);

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
    return { text: l.text, textEn: l.text_en || l.text, quantity, unitPrice, candidates: candidates.slice(0, 4) };
  });

  return { kind: parsed.kind, storeName: parsed.store_name, lines };
}
