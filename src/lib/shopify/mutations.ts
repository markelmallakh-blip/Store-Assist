import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import type { Component } from "@/lib/types";
import { assertNoUserErrors, gql } from "./client";

let cachedLocation: string | null = null;

/** The location inventory is adjusted at: SHOPIFY_LOCATION_ID, or the first active location. */
export async function primaryLocationId(): Promise<string> {
  if (config.shopify.locationId) return config.shopify.locationId;
  if (cachedLocation) return cachedLocation;
  const data: { locations: { nodes: { id: string; isActive: boolean }[] } } = await gql(
    `query Locations { locations(first: 10) { nodes { id isActive } } }`,
  );
  const loc = data.locations.nodes.find((l) => l.isActive) ?? data.locations.nodes[0];
  if (!loc) throw new Error("No Shopify location found");
  cachedLocation = loc.id;
  return loc.id;
}

/**
 * Add (or subtract) available inventory.
 * changeFromQuantity is null on purpose: these are deltas from received stock / bundle sales,
 * and we don't want a concurrent order to make the purchase fail.
 */
export async function adjustInventory(
  changes: { inventoryItemId: string; delta: number }[],
  reason: "received" | "correction" | "other",
  referenceDocumentUri?: string,
) {
  const real = changes.filter((c) => c.delta !== 0);
  if (!real.length) return [];
  const locationId = await primaryLocationId();
  const data: {
    inventoryAdjustQuantities: {
      inventoryAdjustmentGroup: { changes: { delta: number; quantityAfterChange: number | null; item: { id: string } }[] } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  } = await gql(
    `mutation Adjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
        inventoryAdjustmentGroup { changes { name delta quantityAfterChange item { id } } }
        userErrors { field message code }
      }
    }`,
    {
      key: randomUUID(),
      input: {
        name: "available",
        reason,
        referenceDocumentUri,
        changes: real.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId, delta: c.delta, changeFromQuantity: null })),
      },
    },
  );
  assertNoUserErrors("inventoryAdjustQuantities", data.inventoryAdjustQuantities.userErrors);
  return data.inventoryAdjustQuantities.inventoryAdjustmentGroup?.changes ?? [];
}

/** Update "Cost per item" on the inventory item. */
export async function setUnitCost(inventoryItemId: string, cost: number) {
  const data: { inventoryItemUpdate: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
    `mutation Cost($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { field message } }
    }`,
    { id: inventoryItemId, input: { cost } },
  );
  assertNoUserErrors("inventoryItemUpdate", data.inventoryItemUpdate.userErrors);
}

type MetafieldInput = { ownerId: string; namespace: string; key: string; type: string; value: string };

export async function setMetafields(metafields: MetafieldInput[]) {
  // metafieldsSet accepts at most 25 per call.
  for (let i = 0; i < metafields.length; i += 25) {
    const data: { metafieldsSet: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
      `mutation SetMf($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
      }`,
      { metafields: metafields.slice(i, i + 25) },
    );
    assertNoUserErrors("metafieldsSet", data.metafieldsSet.userErrors);
  }
}

export async function deleteMetafields(identifiers: { ownerId: string; namespace: string; key: string }[]) {
  if (!identifiers.length) return;
  const data: { metafieldsDelete: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
    `mutation DelMf($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } }
    }`,
    { metafields: identifiers },
  );
  assertNoUserErrors("metafieldsDelete", data.metafieldsDelete.userErrors);
}

export async function markOrderConfirmed(orderId: string, value: boolean) {
  await setMetafields([
    {
      ownerId: orderId,
      namespace: config.confirmation.namespace,
      key: config.confirmation.key,
      type: "boolean",
      value: String(value),
    },
  ]);
}

export async function addOrderTags(orderId: string, tags: string[]) {
  const data: { tagsAdd: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
    `mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } } }`,
    { id: orderId, tags },
  );
  assertNoUserErrors("tagsAdd", data.tagsAdd.userErrors);
}

/**
 * Save bundle recipes on bundle variants. An empty list is saved as "[]", which means
 * "this is not a bundle, stop suggesting it" (its own stock is real stock).
 * `null` removes the setting entirely.
 */
export async function saveBundleComponents(entries: { variantId: string; components: Component[] | null }[]) {
  await setMetafields(
    entries
      .filter((e) => e.components !== null)
      .map((e) => ({
        ownerId: e.variantId,
        namespace: "store_assist",
        key: "components",
        type: "json",
        value: JSON.stringify(e.components),
      })),
  );
  await deleteMetafields(
    entries.filter((e) => e.components === null).map((e) => ({ ownerId: e.variantId, namespace: "store_assist", key: "components" })),
  );
}

export const WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_EDITED", "ORDERS_CANCELLED", "REFUNDS_CREATE"] as const;

export async function listWebhooks() {
  const data: { webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] } } = await gql(
    `query Hooks { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`,
  );
  return data.webhookSubscriptions.nodes;
}

export async function registerWebhooks(uri: string) {
  const existing = await listWebhooks();
  const results: { topic: string; status: string }[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (existing.some((w) => w.topic === topic && w.uri === uri)) {
      results.push({ topic, status: "already registered" });
      continue;
    }
    const data: { webhookSubscriptionCreate: { userErrors: { field: string[] | null; message: string }[] } } = await gql(
      `mutation Hook($topic: WebhookSubscriptionTopic!, $uri: String!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
          webhookSubscription { id topic } userErrors { field message }
        }
      }`,
      { topic, uri },
    );
    const errs = data.webhookSubscriptionCreate.userErrors;
    results.push({ topic, status: errs.length ? errs.map((e) => e.message).join("; ") : "registered" });
  }
  return results;
}

export async function shopInfo() {
  const data: { shop: { name: string; currencyCode: string; myshopifyDomain: string } } = await gql(
    `query ShopInfo { shop { name currencyCode myshopifyDomain } }`,
  );
  return data.shop;
}
