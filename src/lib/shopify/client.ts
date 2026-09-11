import { config } from "@/lib/config";

type GqlError = { message: string; extensions?: { code?: string } };

export class ShopifyError extends Error {
  constructor(
    message: string,
    public errors: GqlError[] = [],
  ) {
    super(message);
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const { adminToken, clientId, clientSecret, domain } = config.shopify;
  if (adminToken) return adminToken;
  if (!clientId || !clientSecret || !domain) {
    throw new ShopifyError(
      "Shopify is not configured. Set SHOPIFY_STORE_DOMAIN plus SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN).",
    );
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  // Client credentials grant (Dev Dashboard apps installed on your own store). Tokens last 24h.
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new ShopifyError(`Shopify token request failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a GraphQL Admin API operation. Retries on throttling and transient errors.
 * With `allowPartial`, field-level errors (e.g. missing access to customer data) are tolerated
 * and whatever data came back is returned.
 */
export async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { allowPartial?: boolean } = {},
): Promise<T> {
  if (process.env.SHOPIFY_FIXTURES_DIR) return fixture<T>(query);
  const { domain, apiVersion } = config.shopify;
  const url = `https://${domain}/admin/api/${apiVersion}/graphql.json`;

  for (let attempt = 0; ; attempt++) {
    const token = await accessToken();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });

    if (res.status === 401 && !config.shopify.adminToken && attempt === 0) {
      cachedToken = null;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new ShopifyError(`Shopify API ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as { data?: T; errors?: GqlError[] };
    const errors = json.errors ?? [];
    if (errors.some((e) => e.extensions?.code === "THROTTLED") && attempt < 4) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (errors.length && !(opts.allowPartial && json.data)) {
      throw new ShopifyError(errors.map((e) => e.message).join("; "), errors);
    }
    return json.data as T;
  }
}

/**
 * Local preview without Shopify credentials: SHOPIFY_FIXTURES_DIR=./fixtures serves
 * `<OperationName>.json` for queries and pretends every mutation succeeded. Never set this in production.
 */
async function fixture<T>(query: string): Promise<T> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const op = query.match(/\b(query|mutation)\s+(\w+)/);
  if (op?.[1] === "mutation") {
    const field = query.match(/\{\s*(\w+)\s*\(/)?.[1] ?? "result";
    return { [field]: { userErrors: [], inventoryAdjustmentGroup: { changes: [] } } } as T;
  }
  const name = op?.[2] ?? "Unnamed";
  const raw = await readFile(join(process.env.SHOPIFY_FIXTURES_DIR!, `${name}.json`), "utf8").catch(() => {
    throw new ShopifyError(`Fixture mode: missing ${name}.json in ${process.env.SHOPIFY_FIXTURES_DIR}`);
  });
  const json = JSON.parse(raw);
  return (json.data ?? json) as T;
}

/** Throw if a mutation returned userErrors. */
export function assertNoUserErrors(where: string, userErrors: { message: string; field?: string[] | null }[] | undefined) {
  if (userErrors && userErrors.length) {
    throw new ShopifyError(`${where}: ${userErrors.map((e) => e.message).join("; ")}`);
  }
}

/** "your-store.myshopify.com" -> "your-store", used for admin.shopify.com links. */
export function storeHandle() {
  return config.shopify.domain.replace(/\.myshopify\.com$/, "");
}

export function adminOrderUrl(legacyId: string) {
  return `https://admin.shopify.com/store/${storeHandle()}/orders/${legacyId}`;
}

export function adminProductUrl(productGid: string) {
  return `https://admin.shopify.com/store/${storeHandle()}/products/${productGid.split("/").pop()}`;
}
