import { handle } from "@/lib/api";
import { commitPurchase, type CommitLine } from "@/lib/purchase";

export const maxDuration = 60;

export const POST = handle(async (request: Request) => {
  const { lines, note = "" } = (await request.json()) as { lines: CommitLine[]; note?: string };
  if (!Array.isArray(lines) || !lines.length) throw new Error("No items to add");
  const results = await commitPurchase(lines, String(note).slice(0, 200));
  return { results };
});
