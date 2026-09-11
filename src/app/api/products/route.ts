import { handle } from "@/lib/api";
import { loadProducts } from "@/lib/dashboard";

export const GET = handle(async () => loadProducts());
