// Associates an imported audit with the authenticated shop. The shop is always
// taken from the authenticated session; an audit file can never select a store.

import { STORE_MATCH } from "./constants";
import { runGraphql } from "./graphql.server";
import { normalizeHost } from "./text";

export const SHOP_INFO_QUERY = `#graphql
  query StoreAuditShopInfo {
    shop {
      name
      myshopifyDomain
      primaryDomain {
        host
      }
    }
  }`;

export async function fetchShopInfo(admin) {
  const data = await runGraphql(admin, SHOP_INFO_QUERY);
  return {
    name: data.shop.name,
    myshopifyDomain: data.shop.myshopifyDomain,
    primaryDomainHost: data.shop.primaryDomain?.host ?? null,
  };
}

export function evaluateStoreMatch(auditedHost, sessionShop, shopInfo) {
  const audited = normalizeHost(auditedHost);
  if (!audited) {
    return {
      status: STORE_MATCH.UNKNOWN,
      note: "The audit file does not name a public store domain, so it cannot be associated with this store.",
    };
  }
  const own = [sessionShop, shopInfo?.myshopifyDomain, shopInfo?.primaryDomainHost]
    .map(normalizeHost)
    .filter(Boolean);
  if (own.includes(audited)) {
    return { status: STORE_MATCH.MATCHED, note: `Audited domain ${audited} belongs to this store.` };
  }
  return {
    status: STORE_MATCH.MISMATCH,
    note: `Audited domain ${audited} is not this store's primary or myshopify domain (${[...new Set(own)].join(", ")}).`,
  };
}

// MISMATCH can be resolved only by the merchant re-typing the audited domain,
// which records that they attest the domain is served by this store (for
// example a secondary domain). UNKNOWN can never be resolved.
export function validateStoreConfirmation(importRecord, typedHost, acknowledged) {
  if (importRecord.storeMatch !== STORE_MATCH.MISMATCH) {
    return "This audit does not need a store confirmation.";
  }
  if (!acknowledged) return "Tick the confirmation box to continue.";
  const typed = normalizeHost(typedHost);
  if (!typed || typed !== normalizeHost(importRecord.auditedHost)) {
    return `Type the audited domain (${importRecord.auditedHost}) exactly to confirm.`;
  }
  return null;
}

export function canModifyStore(importRecord) {
  if (!importRecord) return false;
  if (importRecord.storeMatch === STORE_MATCH.MATCHED) return true;
  return importRecord.storeMatch === STORE_MATCH.MISMATCH && Boolean(importRecord.storeConfirmedAt);
}
