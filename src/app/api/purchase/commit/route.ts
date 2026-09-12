import { handle } from "@/lib/api";
import { commitPurchase, type CommitLine } from "@/lib/purchase";
import { recordPurchase, validateNewPurchase, type NewPurchase } from "@/lib/purchase-log";

export const maxDuration = 60;

type Body = {
  lines: CommitLine[];
  note?: string;
  paidBy: string;
  purchasedOn: string;
  total: number;
  receipt?: { data: string } | null;
};

export const POST = handle(async (request: Request) => {
  const body = (await request.json()) as Body;
  if (!Array.isArray(body.lines) || !body.lines.length) throw new Error("No items to add");
  const note = String(body.note ?? "").slice(0, 500);
  const receiptData = body.receipt?.data?.replace(/^data:[^,]+,/, "") ?? "";
  if (receiptData.length > 8_000_000) throw new Error("The receipt photo is too large. Try again with a smaller photo.");

  const header: NewPurchase = {
    purchasedOn: body.purchasedOn,
    paidBy: body.paidBy,
    total: Math.round(Number(body.total) * 100) / 100,
    note,
    items: [],
    receipt: receiptData ? { data: receiptData } : null,
  };
  // Check who paid / date / total before touching any stock.
  validateNewPurchase(header);

  const results = await commitPurchase(body.lines, note);
  const items = results.map((r) => ({
    variantId: r.variantId,
    name: r.name,
    qty: r.qty,
    unitCost: body.lines.find((l) => l.variantId === r.variantId)?.unitCost ?? null,
  }));

  let record: Awaited<ReturnType<typeof recordPurchase>> | null = null;
  let recordError: string | undefined;
  try {
    record = await recordPurchase({ ...header, items });
  } catch (e) {
    recordError = e instanceof Error ? e.message : String(e);
  }
  return { results, record, recordError };
});
