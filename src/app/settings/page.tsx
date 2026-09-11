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
};

const TOPICS = ["ORDERS_CREATE", "ORDERS_EDITED", "ORDERS_CANCELLED", "REFUNDS_CREATE"];

export default function SettingsPage() {
  const { data, error, loading, reload } = useApi<Status>("/api/settings");
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
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
            {!data.shopifyConfigured && <p className="text-sm text-fg-muted">Set SHOPIFY_STORE_DOMAIN and the app credentials in the environment.</p>}
            {data.shop && (
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

          <Card className="p-4">
            <Title ok={data.claudeConfigured}>Receipt reading</Title>
            <p className="text-sm text-fg-muted">
              {data.claudeConfigured ? `Photos are read by ${data.claudeModel}.` : "Set ANTHROPIC_API_KEY to read receipts and product photos."}
            </p>
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
