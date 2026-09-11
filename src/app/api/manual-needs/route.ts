import { handle } from "@/lib/api";
import { addManualNeed, removeManualNeed } from "@/lib/manual-needs";

export const POST = handle(async (request: Request) => {
  const body = (await request.json()) as
    | { action: "add"; variantId: string; qty: number; note?: string }
    | { action: "remove"; id: string };
  if (body.action === "add") {
    await addManualNeed({ variantId: body.variantId, qty: Number(body.qty), note: body.note ?? "" });
  } else if (body.action === "remove") {
    await removeManualNeed(body.id);
  } else {
    throw new Error("Unknown action");
  }
  return { ok: true };
});
