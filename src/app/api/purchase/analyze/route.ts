import { handle } from "@/lib/api";
import { receiptReady } from "@/lib/config";
import { readPurchasePhotos } from "@/lib/receipt";
import { getCatalog } from "@/lib/shopify/catalog";

export const maxDuration = 120;

const TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageType = (typeof TYPES)[number];

export const POST = handle(async (request: Request) => {
  if (!receiptReady()) throw new Error("Reading photos needs an AI key (OpenAI or Claude). Add it in Settings → Receipt reading.");
  const { images } = (await request.json()) as { images: { data: string; mediaType: string }[] };
  if (!Array.isArray(images) || !images.length) throw new Error("Add at least one photo");
  if (images.length > 6) throw new Error("Up to 6 photos at a time");
  const clean = images.map((img) => {
    if (!TYPES.includes(img.mediaType as ImageType)) throw new Error(`Unsupported image type ${img.mediaType}`);
    return { data: img.data.replace(/^data:[^,]+,/, ""), mediaType: img.mediaType as ImageType };
  });
  return readPurchasePhotos(clean, await getCatalog());
});
