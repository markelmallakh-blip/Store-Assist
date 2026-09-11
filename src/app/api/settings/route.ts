import { handle } from "@/lib/api";
import { claudeConfigured, config, sheetEnabled, shopifyConfigured } from "@/lib/config";
import { syncOpenOrders } from "@/lib/order-sync";
import { addMissingRows, readInventory, serviceAccountEmail, matchRows } from "@/lib/sheet";
import { getCatalog } from "@/lib/shopify/catalog";
import { listWebhooks, primaryLocationId, registerWebhooks, shopInfo } from "@/lib/shopify/mutations";
import { componentPool } from "@/lib/bundles";

export const maxDuration = 300;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const GET = handle(async () => {
  const status: Record<string, unknown> = {
    shopifyConfigured: shopifyConfigured(),
    claudeConfigured: claudeConfigured(),
    sheetConfigured: sheetEnabled(),
    serviceAccountEmail: serviceAccountEmail(),
    appUrl: config.appUrl,
    webhookUrl: config.appUrl ? `${config.appUrl}/api/webhooks/shopify` : null,
    sentTag: config.confirmation.sentTag,
    confirmedMetafield: `${config.confirmation.namespace}.${config.confirmation.key}`,
    syncBundlesToShopify: config.syncBundlesToShopify,
    lookbackDays: config.lookbackDays,
    claudeModel: config.claude.model,
  };

  if (shopifyConfigured()) {
    try {
      const [shop, location, hooks] = await Promise.all([shopInfo(), primaryLocationId(), listWebhooks()]);
      status.shop = shop;
      status.locationId = location;
      status.webhooks = hooks;
    } catch (e) {
      status.shopifyError = errorText(e);
    }
  }
  if (sheetEnabled()) {
    try {
      const [sheet, catalog] = await Promise.all([readInventory(), getCatalog()]);
      const singles = componentPool(catalog);
      status.sheet = { rows: sheet.rows.length, headers: sheet.headers, matched: matchRows(sheet, singles).size, singles: singles.length };
    } catch (e) {
      status.sheetError = errorText(e);
    }
  }
  return status;
});

export const POST = handle(async (request: Request) => {
  const { action } = (await request.json()) as { action: string };
  switch (action) {
    case "register-webhooks": {
      if (!config.appUrl) throw new Error("Set APP_URL (your deployed https address) first.");
      return { results: await registerWebhooks(`${config.appUrl}/api/webhooks/shopify`) };
    }
    case "sync-open-orders": {
      if (!sheetEnabled() && !config.syncBundlesToShopify) throw new Error("Connect the inventory sheet first.");
      const results = await syncOpenOrders();
      return { results };
    }
    case "add-missing-rows": {
      if (!sheetEnabled()) throw new Error("Connect the inventory sheet first.");
      const added = await addMissingRows(componentPool(await getCatalog()));
      return { added };
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
});
