import { config } from "@/lib/config";
import { canSaveLocally, writeEnvLocal } from "@/lib/env-file";
import { invalidateCatalog } from "./catalog";
import { resetShopifyToken } from "./client";

/**
 * "Connect Shopify" from the Settings page: test a Client ID + secret against the store,
 * then use them right away and (when running locally) save them to .env.local.
 * On a hosted site the keys must be added in the host's environment variables instead.
 */

export function normalizeDomain(input: string) {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(d)) return `${d}.myshopify.com`; // "3ac068-2" -> "3ac068-2.myshopify.com"
  return d;
}


export async function testShopifyCredentials(domainInput: string, clientId: string, clientSecret: string) {
  const domain = normalizeDomain(domainInput);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error("Use your store's myshopify address, e.g. your-store.myshopify.com (Shopify admin → Settings → Domains).");
  }
  if (!/^[A-Za-z0-9_-]{16,}$/.test(clientId.trim()) || !/^[A-Za-z0-9_-]{16,}$/.test(clientSecret.trim())) {
    throw new Error("The Client ID or secret looks incomplete. Copy them again from dev.shopify.com → your app → Settings.");
  }

  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId.trim(), client_secret: clientSecret.trim() }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(
        "Shopify didn't accept these keys. Check the Client ID and secret, and that the app is installed on this store (Dev Dashboard → your app → Install app).",
      );
    }
    throw new Error(`Shopify answered ${res.status}: ${body.slice(0, 200)}`);
  }
  const { access_token, scope } = (await res.json()) as { access_token: string; scope: string };

  const shopRes = await fetch(`https://${domain}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": access_token },
    body: JSON.stringify({ query: "query ShopInfo { shop { name } }" }),
    cache: "no-store",
  });
  const json = (await shopRes.json().catch(() => ({}))) as { data?: { shop?: { name: string } } };
  const needed = ["read_products", "write_products", "read_inventory", "write_inventory", "read_orders", "write_orders", "read_locations"];
  const granted = new Set((scope ?? "").split(",").map((s) => s.trim()));
  return {
    domain,
    shopName: json.data?.shop?.name ?? domain,
    missingScopes: needed.filter((s) => !granted.has(s)),
  };
}

export async function connectShopify(domainInput: string, clientId: string, clientSecret: string) {
  const result = await testShopifyCredentials(domainInput, clientId, clientSecret);

  // Use them immediately in this server process.
  config.shopify.domain = result.domain;
  config.shopify.clientId = clientId.trim();
  config.shopify.clientSecret = clientSecret.trim();
  config.shopify.adminToken = "";
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) config.shopify.webhookSecret = clientSecret.trim();
  delete process.env.SHOPIFY_FIXTURES_DIR;
  resetShopifyToken();
  invalidateCatalog();

  let saved = false;
  if (canSaveLocally()) {
    await writeEnvLocal({
      SHOPIFY_STORE_DOMAIN: result.domain,
      SHOPIFY_CLIENT_ID: clientId.trim(),
      SHOPIFY_CLIENT_SECRET: clientSecret.trim(),
    });
    saved = true;
  }
  return { ...result, saved };
}
