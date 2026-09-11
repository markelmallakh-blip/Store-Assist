import { handle } from "@/lib/api";
import { loadDashboard } from "@/lib/dashboard";

export const GET = handle(async () => loadDashboard());
