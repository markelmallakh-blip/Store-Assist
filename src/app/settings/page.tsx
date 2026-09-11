"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconCheck, IconX } from "@/components/icons";
import { api, Badge, Button, Card, ErrorBox, PageHeader, Skeleton, useApi, useToast } from "@/components/ui";

type Status = {
  shopifyConfigured: boolean;
  claudeConfigured: boolean;
  sheetConfigured: boolean;
  serviceAccountEmail: string | null;
  appUrl: string;
  webhookUrl: string | null;
  sentTag: string;
  confirmedMetafield: string;
  syncBundlesToShopify: boolean;
  lookbackDays: number;
  claudeModel: string;
  shop?: { name: string; currencyCode: string; myshopifyDomain: string };
  locationId?: string;
  webhooks?: { id: string; topic: string; uri: string }[];
  shopifyError?: string;
  sheet?: { rows: number; headers: string[]; matched: number; singles: number };
  sheetError?: string;
  shopDomain: string;
  clientId: string;
  canSaveLocally: boolean;
  openaiConfigured: boolean;
  receiptProvider: "claude" | "openai";
  receiptReady: boolean;
  receiptModel: string;
};

type AiProvider = "openai" | "claude";
const AI_INFO: Record<AiProvider, { label: string; keyUrl: string; keyHelp: string; placeholder: string }> = {
  openai: {
    label: "OpenAI (ChatGPT)",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHelp:
      "Sign in at platform.openai.com with your OpenAI account, add a few dollars under Billing (API use is billed separately from a ChatGPT subscription), then create an API key.",
    placeholder: "sk-…",
  },
  claude: {
    label: "Claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHelp: "Create a key at console.anthropic.com (the account needs a little credit).",
    placeholder: "sk-ant-…",
  },
};

/** Pick OpenAI or Claude and paste its API key; the server checks the key before using it. */
function AiConnect({
  initial,
  canSaveLocally,
  onConnected,
  onCancel,
}: {
  initial: AiProvider;
  canSaveLocally: boolean;
  onConnected: (provider: AiProvider, saved: boolean) => void;
  onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<AiProvider>(initial);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = AI_INFO[provider];

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ saved: boolean }>("/api/settings", {
        json: { action: provider === "openai" ? "connect-openai" : "connect-claude", apiKey: key },
      });
      setKey("");
      onConnected(provider, r.saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={connect} className="space-y-3">
      <p className="text-sm text-fg-muted">An AI reads receipts and product photos (Arabic or English) and matches them to your products. Each photo costs about a cent or two.</p>
      <div role="radiogroup" aria-label="AI provider" className="grid grid-cols-2 gap-1.5 rounded-xl bg-surface-2 p-1 ring-1 ring-inset ring-line">
        {(Object.keys(AI_INFO) as AiProvider[]).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={provider === p}
            onClick={() => {
              setProvider(p);
              setError(null);
            }}
            className={`h-9 rounded-lg text-sm font-medium transition ${provider === p ? "bg-neon text-neon-ink" : "text-fg-muted hover:text-fg"}`}
          >
            {AI_INFO[p].label}
          </button>
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        {info.keyHelp}{" "}
        <a href={info.keyUrl} target="_blank" rel="noreferrer" className="text-neon underline">
          Open the API keys page
        </a>
      </p>
      <div>
        <label htmlFor="ai-key" className="mb-1 block text-xs font-medium text-fg-muted">
          {info.label} API key
        </label>
        <input
          id="ai-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={info.placeholder}
          autoComplete="off"
          spellCheck={false}
          required
          className="h-11 w-full rounded-xl bg-surface-2 px-3 font-mono text-sm ring-1 ring-inset ring-line-strong outline-none focus:ring-2 focus:ring-neon"
        />
      </div>
      {error && <ErrorBox message={error} />}
      {!canSaveLocally && (
        <p className="text-xs text-fg-subtle">
          On the live site the key is only tested here. To keep it, add {provider === "openai" ? "OPENAI_API_KEY and RECEIPT_AI=openai" : "ANTHROPIC_API_KEY"} in Netlify → Environment variables.
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={!key}>
          Connect {info.label}
        </Button>
      </div>
    </form>
  );
}

/** Paste the Shopify app keys here; the server tests them against the store before using them. */
function ShopifyConnect({
  status,
  onConnected,
  onCancel,
}: {
  status: Status;
  onConnected: (shopName: string, saved: boolean) => void;
  onCancel?: () => void;
}) {
  const [domain, setDomain] = useState(status.shopDomain);
  const [clientId, setClientId] = useState(status.clientId);
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const r = await api<{ shopName: string; saved: boolean; missingScopes: string[] }>("/api/settings", {
        json: { action: "connect-shopify", domain, clientId, clientSecret: secret },
      });
      setSecret("");
      if (r.missingScopes.length) setWarning(`Connected, but the app is missing: ${r.missingScopes.join(", ")}. Add them in the Dev Dashboard and release a new version.`);
      onConnected(r.shopName, r.saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const field = "h-11 w-full rounded-xl bg-surface-2 px-3 text-sm ring-1 ring-inset ring-line-strong outline-none focus:ring-2 focus:ring-neon";
  return (
    <form onSubmit={connect} className="space-y-3">
      <p className="text-sm text-fg-muted">
        Paste the keys of your Shopify app (<span className="text-fg">dev.shopify.com → your app → Settings</span>). The app must be installed on your store.
      </p>
      <div>
        <label htmlFor="shop-domain" className="mb-1 block text-xs font-medium text-fg-muted">
          Store address
        </label>
        <input id="shop-domain" className={field} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="your-store.myshopify.com" autoComplete="off" required />
      </div>
      <div>
        <label htmlFor="shop-client-id" className="mb-1 block text-xs font-medium text-fg-muted">
          Client ID
        </label>
        <input id="shop-client-id" className={`${field} font-mono`} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} required />
      </div>
      <div>
        <label htmlFor="shop-secret" className="mb-1 block text-xs font-medium text-fg-muted">
          Client secret
        </label>
        <div className="flex gap-2">
          <input
            id="shop-secret"
            type={show ? "text" : "password"}
            className={`${field} font-mono`}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <Button type="button" variant="secondary" className="h-11 shrink-0" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide secret" : "Show secret"}>
            {show ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {warning && <p className="text-sm text-amber">{warning}</p>}
      {!status.canSaveLocally && (
        <p className="text-xs text-fg-subtle">
          On the live site the keys are only tested here. To keep them, add SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in Netlify → Environment variables.
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={!domain || !clientId || !secret}>
          Connect Shopify
        </Button>
      </div>
    </form>
  );
}

const TOPICS = ["ORDERS_CREATE", "ORDERS_EDITED", "ORDERS_CANCELLED", "REFUNDS_CREATE"];

export default function SettingsPage() {
  const { data, error, loading, reload } = useApi<Status>("/api/settings");
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [editingShopify, setEditingShopify] = useState(false);
  const [editingClaude, setEditingClaude] = useState(false);
  const toast = useToast();
  const router = useRouter();

  async function action(name: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(name);
    setLog(null);
    try {
      const res = await api<Record<string, unknown>>("/api/settings", { json: { action: name } });
      setLog(JSON.stringify(res, null, 2));
      toast.show("Done");
      reload();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  const hooksOk = data?.webhookUrl && TOPICS.every((t) => data.webhooks?.some((w) => w.topic === t && w.uri === data.webhookUrl));

  return (
    <>
      <PageHeader title="Settings" subtitle="Connections and one-time setup" onRefresh={reload} loading={loading}>
        <Button size="sm" variant="ghost" onClick={logout}>
          Sign out
        </Button>
      </PageHeader>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {!data && loading && <Skeleton rows={4} />}

      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <Title ok={Boolean(data.shop)}>Shopify</Title>
            {data.shopifyError && <ErrorBox message={data.shopifyError} />}
            {(!data.shop || editingShopify) && (
              <ShopifyConnect
                status={data}
                onCancel={data.shop ? () => setEditingShopify(false) : undefined}
                onConnected={(name, saved) => {
                  setEditingShopify(false);
                  toast.show(saved ? `Connected to ${name}` : `Keys work for ${name}. Add them in Netlify to keep them.`);
                  reload();
                }}
              />
            )}
            {data.shop && !editingShopify && (
              <div className="mb-3 flex items-center justify-between gap-2">
                <Badge tone="green">
                  <IconCheck className="size-3.5" /> Connected
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => setEditingShopify(true)}>
                  Change keys
                </Button>
              </div>
            )}
            {data.shop && !editingShopify && (
              <Rows
                rows={[
                  ["Store", `${data.shop.name} (${data.shop.myshopifyDomain})`],
                  ["Inventory location", data.locationId ?? "—"],
                  ["Confirmed flag", data.confirmedMetafield],
                  ['"Sent" tag', data.sentTag],
                  ["Open orders window", `${data.lookbackDays} days`],
                  ["Bundles reduce Shopify singles", data.syncBundlesToShopify ? "Yes" : "No (sheet only)"],
                ]}
              />
            )}
          </Card>

          <Card className="p-4">
            <Title ok={Boolean(hooksOk)}>Order webhooks</Title>
            <p className="mb-3 text-sm text-fg-muted">
              Shopify tells Store Assist about new, edited, refunded and cancelled orders so the actual sheet is updated automatically.
            </p>
            {!data.appUrl && <p className="mb-3 text-sm text-amber">Set APP_URL to the deployed https address first.</p>}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {TOPICS.map((t) => {
                const on = data.webhooks?.some((w) => w.topic === t && w.uri === data.webhookUrl);
                return (
                  <Badge key={t} tone={on ? "green" : "stone"}>
                    {t.toLowerCase().replace("_", "/")}
                  </Badge>
                );
              })}
            </div>
            <Button size="sm" variant="primary" disabled={!data.appUrl || !data.shop} loading={busy === "register-webhooks"} onClick={() => action("register-webhooks")}>
              Register webhooks
            </Button>
          </Card>

          <Card className="p-4">
            <Title ok={Boolean(data.sheet)}>Actual inventory sheet</Title>
            {!data.sheetConfigured ? (
              <div className="space-y-2 text-sm text-fg-muted">
                <p>Not connected yet. When you&apos;re ready:</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>Create a Google Cloud service account, download its JSON key, and set GOOGLE_SERVICE_ACCOUNT_JSON.</li>
                  <li>Share your Google Sheet with the service account email (Editor).</li>
                  <li>Set GOOGLE_SHEET_ID (the long id in the sheet URL) and redeploy.</li>
                </ol>
                <p>
                  Expected columns on the <b>Inventory</b> tab: <code>Variant ID · SKU · Product · Actual Qty · Cost · Updated At</code> (names are configurable). A{" "}
                  <b>Movements</b> tab is created automatically as the change log.
                </p>
              </div>
            ) : (
              <>
                {data.sheetError && <ErrorBox message={data.sheetError} />}
                {data.serviceAccountEmail && (
                  <p className="mb-2 text-xs text-fg-muted">
                    Shared with: <code>{data.serviceAccountEmail}</code>
                  </p>
                )}
                {data.sheet && (
                  <Rows
                    rows={[
                      ["Rows", String(data.sheet.rows)],
                      ["Products matched", `${data.sheet.matched} of ${data.sheet.singles}`],
                      ["Columns", data.sheet.headers.join(" · ")],
                    ]}
                  />
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === "add-missing-rows"} onClick={() => action("add-missing-rows", "Add a row for every product that isn't in the sheet yet? Actual Qty stays blank for you to count.")}>
                    Add missing products
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === "sync-open-orders"}
                    onClick={() =>
                      action(
                        "sync-open-orders",
                        "Subtract all open, unfulfilled orders from the sheet? Do this once, right after counting stock. Orders already applied are skipped automatically.",
                      )
                    }
                  >
                    Apply open orders to sheet
                  </Button>
                </div>
              </>
            )}
          </Card>

          <Card className="scroll-mt-20 p-4">
            <div id="receipt-reading" />
            <Title ok={data.receiptReady}>Receipt reading</Title>
            {data.receiptReady && !editingClaude ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-fg-muted">
                  Photos are read by {data.receiptProvider === "openai" ? "OpenAI" : "Claude"} ({data.receiptModel}), Arabic and English.
                </p>
                <Button size="sm" variant="ghost" onClick={() => setEditingClaude(true)}>
                  Change
                </Button>
              </div>
            ) : (
              <AiConnect
                initial={data.receiptProvider === "claude" && data.claudeConfigured ? "claude" : "openai"}
                canSaveLocally={data.canSaveLocally}
                onCancel={data.receiptReady ? () => setEditingClaude(false) : undefined}
                onConnected={(provider, saved) => {
                  setEditingClaude(false);
                  const name = provider === "openai" ? "OpenAI" : "Claude";
                  toast.show(saved ? `Receipt reading connected to ${name}` : `Key works. Add it in Netlify to keep it.`);
                  reload();
                }}
              />
            )}
          </Card>

          {log && (
            <Card className="p-4 lg:col-span-2">
              <div className="mb-2 text-sm font-medium">Last result</div>
              <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 text-xs">{log}</pre>
            </Card>
          )}
        </div>
      )}
      {toast.node}
    </>
  );
}

function Title({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className={`grid size-6 place-items-center rounded-full ${ok ? "bg-green/15 text-green" : "bg-surface-3 text-fg-muted"}`}>
        {ok ? <IconCheck className="size-4" /> : <IconX className="size-4" />}
      </span>
      <h2 className="font-semibold">{children}</h2>
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-line text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3 py-1.5">
          <dt className="w-40 shrink-0 text-fg-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
