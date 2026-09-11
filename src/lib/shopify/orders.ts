import { config } from "@/lib/config";
import type { Order } from "@/lib/types";
import { gql } from "./client";

const ORDERS_QUERY = /* GraphQL */ `
  query Orders($cursor: String, $q: String!) {
    orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        legacyResourceId
        name
        createdAt
        cancelledAt
        closed
        tags
        sourceName
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { displayName }
        shippingAddress { name phone }
        phone
        confirmed: metafield(namespace: "${config.confirmation.namespace}", key: "${config.confirmation.key}") { value }
        lineItems(first: 100) {
          nodes { id title variantTitle sku quantity currentQuantity unfulfilledQuantity variant { id } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ORDER_QUERY = /* GraphQL */ `
  query OrderForSync($id: ID!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      createdAt
      cancelledAt
      closed
      tags
      sourceName
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      phone
      confirmed: metafield(namespace: "${config.confirmation.namespace}", key: "${config.confirmation.key}") { value }
      applied: metafield(namespace: "store_assist", key: "applied") { value }
      lineItems(first: 250) {
        nodes { id title variantTitle sku quantity currentQuantity unfulfilledQuantity variant { id } }
      }
    }
  }
`;

type RawOrder = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  tags: string[];
  sourceName: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customer?: { displayName: string } | null;
  shippingAddress?: { name: string | null; phone: string | null } | null;
  phone: string | null;
  confirmed: { value: string } | null;
  applied?: { value: string } | null;
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      sku: string | null;
      quantity: number;
      currentQuantity: number;
      unfulfilledQuantity: number;
      variant: { id: string } | null;
    }[];
  };
};

function toOrder(o: RawOrder): Order {
  return {
    id: o.id,
    legacyId: o.legacyResourceId,
    name: o.name,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    closed: o.closed,
    tags: o.tags,
    sourceName: o.sourceName,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    total: Number(o.totalPriceSet.shopMoney.amount),
    currency: o.totalPriceSet.shopMoney.currencyCode,
    customerName: o.customer?.displayName ?? o.shippingAddress?.name ?? null,
    phone: o.shippingAddress?.phone || o.phone || null,
    confirmed: o.confirmed?.value ?? null,
    lines: o.lineItems.nodes.map((l) => ({
      id: l.id,
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      currentQuantity: l.currentQuantity,
      unfulfilledQuantity: l.unfulfilledQuantity,
      variantId: l.variant?.id ?? null,
    })),
  };
}

function daysAgoIso(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Open (not cancelled, not archived) orders from the lookback window, newest first. */
export async function getOpenOrders(days = config.lookbackDays): Promise<Order[]> {
  const q = `status:open created_at:>=${daysAgoIso(days)}`;
  const out: Order[] = [];
  let cursor: string | null = null;
  do {
    // allowPartial: customer name/phone need protected-customer-data access; the rest still works without it.
    const data: { orders: { nodes: RawOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await gql(
      ORDERS_QUERY,
      { cursor, q },
      { allowPartial: true },
    );
    for (const node of data.orders.nodes) if (node) out.push(toOrder(node));
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor && out.length < 1000);
  return out.filter((o) => !o.cancelledAt);
}

/** Orders changed recently, for the cron safety-net sync. */
export async function getRecentlyUpdatedOrderIds(hours: number): Promise<string[]> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const data: { orders: { nodes: { id: string }[] } } = await gql(
    `query Recent($q: String!) { orders(first: 250, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes { id } } }`,
    { q: `updated_at:>='${since}'` },
  );
  return data.orders.nodes.map((n) => n.id);
}

export async function getOrderForSync(id: string): Promise<(Order & { applied: string | null }) | null> {
  const data: { order: RawOrder | null } = await gql(ORDER_QUERY, { id }, { allowPartial: true });
  if (!data.order) return null;
  return { ...toOrder(data.order), applied: data.order.applied?.value ?? null };
}
