# Store Assist · Cupcairo

A small admin dashboard for the Cupcairo Shopify store. Open it in the morning (or on your phone) and it tells you what needs doing:

| Screen | What it does |
|---|---|
| **Today** | **To buy**: items open orders need that you don't have (Shopify stock below zero, bundle items, or the actual sheet below zero), with the orders that need them. **+ Add** puts anything else on the list by hand (shown as *Added manually*, stored in the shop metafield `store_assist.manual_needs`); recording a purchase of that item clears it. **Confirmations**: open orders where `custom.confirmed` isn't true, split into *not sent*, *sent, waiting reply*, and *marked not confirmed*, with WhatsApp / Shopify links and one-tap **Mark sent** / **Confirmed**. |
| **Purchase** | Take a photo (JPG, PNG or iPhone HEIC) of a receipt or the products. OpenAI or Claude (your choice in Settings) reads it, Arabic or English, and matches items to your catalog; when unsure it shows the likely products so you choose. Set quantity and cost, and it adds the stock to Shopify, updates *Cost per item*, and adds it to the actual inventory sheet. |
| **Products** | Every product with Shopify qty, actual (sheet) qty, cost, price, and margin. Filters for below zero, Shopify ≠ actual, not in sheet, no cost. |
| **Bundles** | Tell it which single items each bundle uses (e.g. *Davidoff Bundle · Rich Aroma / Espresso 57* = 1× Rich Aroma + 1× Espresso 57). Suggestions are pre-filled from option names and SKUs; accept or edit. |
| **Settings** | Connection status, webhook registration, sheet tools. |

## How stock is tracked

- **Shopify** keeps its own available count. Store Assist only changes it when you record a purchase (and for bundles, if `SYNC_BUNDLES_TO_SHOPIFY=true`).
- **Actual inventory sheet** (Google Sheet) is your real count. Store Assist updates it automatically:
  - order placed → subtracts the items (bundles are expanded into their single items)
  - order edited / refunded → adjusts by the difference
  - order cancelled → adds the items back
  - purchase recorded → adds the items and updates cost

  Each order remembers what it already took (order metafield `store_assist.applied`), so re-running a sync never double-counts. Every change is written to the **Movements** tab.
- "Actual Qty" means *free to sell*: shelf count minus items already reserved for unfulfilled orders.

Bundle recipes are saved on each bundle variant as the metafield `store_assist.components`. `[]` means "not a bundle, it has its own stock".

Clear cases are applied **automatically**, with no setup needed: multipacks whose barcode *and* name match one single ("2 Jars El Mordjene … 700g" → 2× the 700g jar), and products of type *Bundles* whose options clearly name singles (Davidoff Bundle). They show as *Automatic* on the Bundles page; **Edit** or **Not a bundle** overrides them. Everything less certain waits on the Bundles page.

## Setup

### 1. Shopify app
1. Go to [dev.shopify.com](https://dev.shopify.com) → Apps → **Create app** (Dev Dashboard; admin-created custom apps can no longer be made).
2. Access scopes: `read_products, write_products, read_inventory, write_inventory, read_orders, write_orders, read_locations, read_customers`.
3. Under protected customer data, enable **Name** and **Phone** (without this, confirmations still work but show no name/phone).
4. Release a version and install it on the Cupcairo store.
5. Copy **Client ID** and **Client secret** into `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`.

### 2. Deploy (Netlify)
1. [app.netlify.com](https://app.netlify.com) → **Add new project → Import an existing project → GitHub** → pick this repo. Build settings come from `netlify.toml`.
2. Environment variables: `ADMIN_PASSWORD`, `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` (and `OPENAI_API_KEY` + `RECEIPT_AI=openai`, or `ANTHROPIC_API_KEY`, for receipt reading). The session and cron secrets are derived automatically, and the site address comes from Netlify's `URL`.
3. Open the site → **Settings** → **Register webhooks**.
4. On your phone, open the site and use *Add to Home Screen*.

`netlify/functions/daily-sync.mts` runs a daily safety-net sync (`/api/cron/sync`) in case a webhook was missed.

### 3. Actual inventory sheet (when ready)
1. In Google Cloud, create a service account and a JSON key. Put the JSON in `GOOGLE_SERVICE_ACCOUNT_JSON`.
2. Share the Google Sheet with the service account email as **Editor**; set `GOOGLE_SHEET_ID`.
3. Inventory tab columns (names configurable): `Variant ID · SKU · Product · Actual Qty · Cost · Updated At`. Rows are matched by Variant ID, then SKU, then exact name; a match is used only when it's unambiguous, and the Variant ID is filled in automatically after the first match.
4. **Settings → Add missing products** to add a row for every product not in the sheet yet. Count and fill **Actual Qty**.
5. Right after counting: **Settings → Apply open orders to sheet** (once), and set `SHEET_SYNC_FROM` to that date.

### 4. CK WhatsApp confirmations
The "Order confirmation" badge inside CK isn't visible to other apps. The dashboard treats an order as *sent* when it has the tag `CONFIRMATION_SENT_TAG`. You can tap **Mark sent**, or set CK / Shopify Flow to add a tag when CK sends the confirmation and put that tag name in `CONFIRMATION_SENT_TAG`.

## Publishing changes

Netlify is connected to this GitHub repo, so every push to `main` goes live in a minute or two. After editing and checking on `localhost:3000`:

```bash
npm run ship
```

It type-checks and lints first (a broken edit never goes live), then commits and pushes. Netlify keeps every deploy, so a bad one can be rolled back from the Netlify dashboard (Deploys → pick a deploy → Publish deploy).

## Local development

```bash
cp .env.example .env.local   # fill in values
npm install
npm run dev
```

To preview without Shopify credentials, set `SHOPIFY_FIXTURES_DIR` to a folder with `Catalog.json`, `Orders.json`, `ShopInfo.json`, `Locations.json`, `Hooks.json` (raw GraphQL responses). Writes are simulated in that mode.

Stack: Next.js 16 (App Router), Tailwind 4, Shopify Admin GraphQL `2026-07`, Google Sheets API, OpenAI (`gpt-5.6`) or Claude (`claude-opus-5`) for receipt reading.
