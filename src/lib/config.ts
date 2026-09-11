import { createHash } from "node:crypto";

// Central place for every environment variable the app reads.
// See .env.example for descriptions.

function bool(value: string | undefined, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  shopify: {
    // e.g. your-store.myshopify.com
    domain: (process.env.SHOPIFY_STORE_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
    // Either a legacy admin-created custom app token...
    adminToken: process.env.SHOPIFY_ADMIN_TOKEN || "",
    // ...or a Dev Dashboard app (client credentials grant).
    clientId: process.env.SHOPIFY_CLIENT_ID || "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
    // Webhook HMAC secret. Dev Dashboard apps sign webhooks with the client secret.
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET || "",
    locationId: process.env.SHOPIFY_LOCATION_ID || "",
  },

  confirmation: {
    namespace: process.env.CONFIRMED_METAFIELD_NAMESPACE || "custom",
    key: process.env.CONFIRMED_METAFIELD_KEY || "confirmed",
    // Tag that means "confirmation message was sent" (set by CK automation later, or by the dashboard button).
    sentTag: process.env.CONFIRMATION_SENT_TAG || "confirmation-sent",
  },

  // How far back to look for open orders.
  lookbackDays: int(process.env.ORDER_LOOKBACK_DAYS, 60),

  // When true, selling a bundle also subtracts its single items from Shopify inventory.
  syncBundlesToShopify: bool(process.env.SYNC_BUNDLES_TO_SHOPIFY, false),

  // Orders created before this date are ignored by the sheet sync unless they are still unfulfilled
  // (the "Sync open orders" backfill picks those up).
  sheetSyncFrom: process.env.SHEET_SYNC_FROM || "",

  sheet: {
    id: process.env.GOOGLE_SHEET_ID || "",
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
    inventoryTab: process.env.SHEET_INVENTORY_TAB || "Inventory",
    logTab: process.env.SHEET_LOG_TAB || "Movements",
    columns: {
      variantId: process.env.SHEET_COL_VARIANT_ID || "Variant ID",
      sku: process.env.SHEET_COL_SKU || "SKU",
      name: process.env.SHEET_COL_NAME || "Product",
      qty: process.env.SHEET_COL_QTY || "Actual Qty",
      cost: process.env.SHEET_COL_COST || "Cost",
      updatedAt: process.env.SHEET_COL_UPDATED_AT || "Updated At",
    },
  },

  auth: {
    password: process.env.ADMIN_PASSWORD || "",
    // Optional: derived from the admin password when not set (changing the password then signs everyone out).
    sessionSecret: process.env.SESSION_SECRET || derive("session", process.env.ADMIN_PASSWORD),
    sessionDays: int(process.env.SESSION_DAYS, 30),
  },

  claude: {
    model: process.env.CLAUDE_MODEL || "claude-opus-5",
    effort: (process.env.CLAUDE_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max",
  },

  // APP_URL, or the address the host provides (Netlify: URL, Vercel: VERCEL_PROJECT_PRODUCTION_URL).
  appUrl: (
    process.env.APP_URL ||
    process.env.URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "")
  ).replace(/\/$/, ""),
  // Optional: derived from the Shopify client secret when not set (netlify/functions/daily-sync.mts does the same).
  cronSecret: process.env.CRON_SECRET || derive("cron", process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_ADMIN_TOKEN),
};

/** A stable secret derived from another server-only secret, so fewer values need to be configured. */
function derive(purpose: string, from: string | undefined) {
  return from ? createHash("sha256").update(`store-assist:${purpose}:${from}`).digest("hex") : "";
}

export const sheetEnabled = () => Boolean(config.sheet.id && config.sheet.serviceAccountJson);
export const shopifyConfigured = () =>
  Boolean(config.shopify.domain && (config.shopify.adminToken || (config.shopify.clientId && config.shopify.clientSecret)));
export const claudeConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
