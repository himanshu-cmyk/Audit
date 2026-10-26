// Maps audited storefront URLs to resources in the authenticated shop. Only the
// handle is taken from the URL; the resource itself is always looked up through
// the authenticated Admin API, so it necessarily belongs to the session's shop.

import { FixError, runGraphql } from "./graphql.server";
import { normalizeHost, safeHttpUrl } from "./text";

const HANDLE_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,254}$/u;
const LOCALE_RE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

export const GID_RE = {
  Product: /^gid:\/\/shopify\/Product\/\d{1,20}$/,
  Collection: /^gid:\/\/shopify\/Collection\/\d{1,20}$/,
  MediaImage: /^gid:\/\/shopify\/MediaImage\/\d{1,20}$/,
  OnlineStoreTheme: /^gid:\/\/shopify\/OnlineStoreTheme\/\d{1,20}$/,
};

export function assertGid(type, id) {
  if (typeof id !== "string" || !GID_RE[type]?.test(id)) {
    throw new FixError("INVALID_RESOURCE_ID", `Missing or invalid ${type} ID.`);
  }
  return id;
}

export function isValidHandle(handle) {
  return typeof handle === "string" && HANDLE_RE.test(handle);
}

const MANUAL_REASONS = {
  home: "Homepage title and meta description are set in Online Store > Preferences. There is no supported Admin API scope in this app to change them, so update them manually.",
  page: "Online Store pages need the write_online_store_pages scope, which this app does not request. Edit the page's Search engine listing in Shopify Admin.",
  blog: "Blog posts need the write_online_store_pages / content scopes, which this app does not request. Edit the post's Search engine listing in Shopify Admin.",
  cart: "The cart page is rendered by the theme and has no editable SEO fields.",
  other: "This page type is not supported for automatic fixes.",
  foreign: "This URL is not on the audited store domain, so it was ignored.",
  invalid: "This is not a valid storefront URL.",
};

export function classifyStoreUrl(rawUrl, auditedHost) {
  const href = safeHttpUrl(rawUrl);
  if (!href) return { kind: "invalid", reason: MANUAL_REASONS.invalid };
  const u = new URL(href);
  const host = normalizeHost(u.hostname);
  if (!host || host !== normalizeHost(auditedHost)) {
    return { kind: "foreign", reason: MANUAL_REASONS.foreign };
  }
  let segs;
  try {
    segs = u.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return { kind: "invalid", reason: MANUAL_REASONS.invalid };
  }
  if (segs.length >= 2 && LOCALE_RE.test(segs[0]) && ["products", "collections", "pages", "blogs"].includes(segs[1])) {
    segs = segs.slice(1);
  }
  if (segs.length === 0) return { kind: "home", reason: MANUAL_REASONS.home };
  if (segs[0] === "products" && segs.length === 2 && isValidHandle(segs[1])) {
    return { kind: "product", handle: segs[1] };
  }
  if (segs[0] === "collections" && segs.length === 4 && segs[2] === "products" && isValidHandle(segs[3])) {
    return { kind: "product", handle: segs[3] };
  }
  if (segs[0] === "collections" && segs.length === 2 && isValidHandle(segs[1])) {
    return { kind: "collection", handle: segs[1] };
  }
  if (segs[0] === "pages") return { kind: "page", reason: MANUAL_REASONS.page };
  if (segs[0] === "blogs") return { kind: "blog", reason: MANUAL_REASONS.blog };
  if (segs[0] === "cart") return { kind: "cart", reason: MANUAL_REASONS.cart };
  return { kind: "other", reason: MANUAL_REASONS.other };
}

export const PRODUCT_BY_HANDLE_QUERY = `#graphql
  query StoreAuditProductByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id
      title
      handle
    }
  }`;

export const COLLECTION_BY_HANDLE_QUERY = `#graphql
  query StoreAuditCollectionByHandle($handle: String!) {
    collectionByIdentifier(identifier: { handle: $handle }) {
      id
      title
      handle
    }
  }`;

export async function lookupByHandle(admin, kind, handle) {
  if (!isValidHandle(handle)) return null;
  if (kind === "product") {
    const data = await runGraphql(admin, PRODUCT_BY_HANDLE_QUERY, { handle });
    const p = data.productByIdentifier;
    return p && GID_RE.Product.test(p.id) ? p : null;
  }
  if (kind === "collection") {
    const data = await runGraphql(admin, COLLECTION_BY_HANDLE_QUERY, { handle });
    const c = data.collectionByIdentifier;
    return c && GID_RE.Collection.test(c.id) ? c : null;
  }
  return null;
}
