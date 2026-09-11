// Shared shapes used by the server libs and the UI.

export type Component = { variantId: string; qty: number };

export type Variant = {
  id: string;
  productId: string;
  productTitle: string;
  /** null for single-variant products ("Default Title"). */
  variantTitle: string | null;
  /** Product title plus variant title, for display. */
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  /** Shopify "available" quantity at all locations. */
  shopifyQty: number;
  tracked: boolean;
  inventoryItemId: string;
  cost: number | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED" | string;
  productType: string;
  vendor: string;
  image: string | null;
  options: { name: string; value: string }[];
  /** Bundle recipe saved in the store_assist.components metafield. null = not a bundle. */
  components: Component[] | null;
  /** Explicitly marked "not a bundle" (metafield saved as an empty list). */
  notBundle: boolean;
  /** Where `components` came from: saved on the Bundles page, or applied automatically. */
  recipeSource: "saved" | "auto" | null;
};

export type OrderLine = {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  currentQuantity: number;
  unfulfilledQuantity: number;
  variantId: string | null;
};

export type Order = {
  id: string;
  legacyId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  tags: string[];
  sourceName: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string;
  total: number;
  currency: string;
  customerName: string | null;
  phone: string | null;
  /** "true" | "false" | null (not set) */
  confirmed: string | null;
  lines: OrderLine[];
};

export type SheetRow = {
  /** 1-based row number in the sheet. */
  row: number;
  variantId: string | null;
  sku: string | null;
  name: string | null;
  qty: number | null;
  cost: number | null;
};

export type ToBuyItem = {
  variantId: string;
  name: string;
  image: string | null;
  sku: string | null;
  vendor: string;
  need: number;
  shopifyQty: number;
  /** Shopify qty minus open bundle demand that Shopify doesn't know about. */
  shopifyEffective: number;
  actualQty: number | null;
  openDemand: number;
  bundleDemand: number;
  cost: number | null;
  orders: { name: string; legacyId: string; qty: number; viaBundle: string | null }[];
  reasons: string[];
  /** false = no open order needs it right now; the stock count itself is below zero. */
  forOpenOrders: boolean;
  /** Needs someone added by hand on the Today page (included in `need`). */
  manual: { id: string; qty: number; note: string; addedAt: string }[];
};

export type UnmappedBundleAlert = {
  variantId: string;
  name: string;
  orders: string[];
};

export type ConfirmationState = "not_sent" | "sent" | "declined";

export type ConfirmationItem = {
  orderId: string;
  legacyId: string;
  name: string;
  createdAt: string;
  customerName: string | null;
  phone: string | null;
  whatsapp: string | null;
  total: number;
  currency: string;
  state: ConfirmationState;
  fulfillmentStatus: string;
  sourceName: string | null;
  itemsSummary: string;
  adminUrl: string;
};

export type ProductRow = {
  variantId: string;
  productId: string;
  name: string;
  image: string | null;
  sku: string | null;
  vendor: string;
  productType: string;
  status: string;
  tracked: boolean;
  shopifyQty: number;
  actualQty: number | null;
  inSheet: boolean;
  cost: number | null;
  price: number;
  isBundle: boolean;
  adminUrl: string;
};
