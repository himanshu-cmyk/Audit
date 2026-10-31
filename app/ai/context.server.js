// Extra store facts for drafting SEO text. Read-only, bounded, and limited to
// public catalog data: no customers, orders, prices or tokens. A failed read
// only means less evidence; it never blocks the suggestion.

import { FixError, runGraphql } from "../fixes/graphql.server";

export const COLLECTION_CONTEXT_QUERY = `#graphql
  query StoreAuditCollectionContext($id: ID!) {
    collection(id: $id) {
      id
      productsCount {
        count
      }
      products(first: 10) {
        nodes {
          title
          productType
          vendor
          description(truncateAt: 160)
        }
      }
    }
  }`;

export const PRODUCT_CONTEXT_QUERY = `#graphql
  query StoreAuditProductContext($id: ID!) {
    product(id: $id) {
      id
      tags
      productType
      vendor
    }
  }`;

const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

/** { collectionProducts, productCount, tags, productType, vendor } — all optional. */
export async function resourceContext(admin, plan) {
  try {
    if (plan.resourceType === "Collection") {
      const c = (await runGraphql(admin, COLLECTION_CONTEXT_QUERY, { id: plan.resourceId })).collection;
      if (!c || c.id !== plan.resourceId) return {};
      return {
        productCount: c.productsCount?.count ?? null,
        collectionProducts: (c.products?.nodes || []).map((p) => ({
          title: clean(p.title, 120),
          productType: clean(p.productType, 60),
          vendor: clean(p.vendor, 60),
          description: clean(p.description, 160),
        })),
      };
    }
    if (plan.resourceType === "Product") {
      const p = (await runGraphql(admin, PRODUCT_CONTEXT_QUERY, { id: plan.resourceId })).product;
      if (!p || p.id !== plan.resourceId) return {};
      return { tags: (p.tags || []).slice(0, 15).map((t) => clean(t, 40)), productType: clean(p.productType, 60), vendor: clean(p.vendor, 60) };
    }
  } catch (err) {
    if (!(err instanceof FixError) || err.code === "SESSION_EXPIRED") throw err;
  }
  return {};
}
