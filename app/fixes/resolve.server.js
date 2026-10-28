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
  special: "This is a Shopify-generated listing (for example /collections/all, vendor or type pages), not a collection you can edit. Fix it manually in the theme.",
  file: "This URL points to a data or feed endpoint (.json, .js, .xml, .atom, .oembed), not a storefront page.",
  ambiguous: "This URL cannot be mapped to exactly one product or collection.",
  foreign: "This URL is not on the audited store domain, so it was ignored.",
  invalid: "This is not a valid storefront URL.",
};

// Shopify-generated collection routes that do not correspond to an editable collection.
const SPECIAL_COLLECTIONS = new Set(["all", "vendors", "types"]);

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
  // A locale prefix is accepted only directly before a known resource segment.
  let locale = null;
  if (segs.length >= 2 && LOCALE_RE.test(segs[0]) && ["products", "collections", "pages", "blogs"].includes(segs[1])) {
    locale = segs[0].toLowerCase();
    segs = segs.slice(1);
  }
  const last = segs[segs.length - 1] || "";
  if (/\.(json|js|xml|atom|oembed|rss)$/i.test(last)) return { kind: "file", reason: MANUAL_REASONS.file };
  if (segs[0] === "collections" && segs.length >= 2 && SPECIAL_COLLECTIONS.has(segs[1].toLowerCase())) {
    // /collections/all/products/<handle> still names a real product.
    if (segs.length === 4 && segs[2] === "products" && isValidHandle(segs[3])) {
      return { kind: "product", handle: segs[3], locale, viaCollection: segs[1] };
    }
    return { kind: "special", reason: MANUAL_REASONS.special };
  }
  if (segs.length === 0) return { kind: "home", reason: MANUAL_REASONS.home };
  if (segs[0] === "products" && segs.length === 2 && isValidHandle(segs[1])) {
    return { kind: "product", handle: segs[1], locale };
  }
  // A collection-qualified product URL renders the product by its handle; the
  // collection segment is kept for display only and never selects a resource.
  if (segs[0] === "collections" && segs.length === 4 && segs[2] === "products" && isValidHandle(segs[3])) {
    return { kind: "product", handle: segs[3], locale, viaCollection: segs[1] };
  }
  if (segs[0] === "collections" && segs.length === 2 && isValidHandle(segs[1])) {
    return { kind: "collection", handle: segs[1], locale };
  }
  if (segs[0] === "products" || segs[0] === "collections") return { kind: "ambiguous", reason: MANUAL_REASONS.ambiguous };
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

// The returned resource must carry exactly the handle that was asked for.
const sameHandle = (a, b) => typeof a === "string" && a.toLowerCase() === String(b).toLowerCase();

export async function lookupByHandle(admin, kind, handle) {
  if (!isValidHandle(handle)) return null;
  if (kind === "product") {
    const data = await runGraphql(admin, PRODUCT_BY_HANDLE_QUERY, { handle });
    const p = data.productByIdentifier;
    return p && GID_RE.Product.test(p.id) && sameHandle(p.handle, handle) ? p : null;
  }
  if (kind === "collection") {
    const data = await runGraphql(admin, COLLECTION_BY_HANDLE_QUERY, { handle });
    const c = data.collectionByIdentifier;
    return c && GID_RE.Collection.test(c.id) && sameHandle(c.handle, handle) ? c : null;
  }
  return null;
}
