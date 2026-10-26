// Optional post-fix storefront re-check for SEO changes: fetches the public page
// and re-runs the same title / meta-description checks the audit's SEO detector
// uses. The URL is built server-side from the shop's own primary domain and the
// resource handle returned by the Admin API, never from user or audit input.

import { EXEC } from "./constants";
import { FixError } from "./graphql.server";
import { isValidHandle } from "./resolve.server";
import { fetchShopInfo } from "./storeMatch.server";
import { cleanLine, normalizeHost, safeJsonParse } from "./text";

const SEO_TYPES = {
  product_seo_title: { path: "products", field: "title" },
  product_seo_description: { path: "products", field: "description" },
  collection_seo_title: { path: "collections", field: "title" },
  collection_seo_description: { path: "collections", field: "description" },
};

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function extractHeadSeo(html) {
  const head = html.split(/<\/head\s*>/i)[0];
  const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTag = head.match(/<meta\s[^>]*name\s*=\s*["']description["'][^>]*>/i);
  const content = metaTag?.[0].match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i);
  return {
    title: t ? decodeEntities(t[1]).replace(/\s+/g, " ").trim() : null,
    description: content ? decodeEntities(content[1] ?? content[2]).replace(/\s+/g, " ").trim() : null,
  };
}

export async function liveCheckPlan({ db, admin, session, planId, fetchImpl = fetch }) {
  const plan = await db.fixExecution.findFirst({ where: { id: planId, shop: session.shop } });
  if (!plan) throw new FixError("NOT_FOUND", "Change not found.");
  const cfg = SEO_TYPES[plan.fixType];
  if (!cfg || plan.status !== EXEC.APPLIED) {
    throw new FixError("INVALID_STATE", "Storefront re-checks are available for applied SEO changes only.");
  }
  const before = safeJsonParse(plan.beforeJson, {});
  const approved = safeJsonParse(plan.approvedJson, {});
  if (!isValidHandle(before.handle)) throw new FixError("INVALID_STATE", "The resource handle is unknown.");

  const shopInfo = await fetchShopInfo(admin);
  const host = normalizeHost(shopInfo.primaryDomainHost) ? shopInfo.primaryDomainHost : shopInfo.myshopifyDomain;
  const url = `https://${host}/${cfg.path}/${encodeURIComponent(before.handle)}`;

  let result;
  try {
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { accept: "text/html", "user-agent": "StoreAudit-FixVerifier/1.0" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") || "";
      result = {
        status: "UNAVAILABLE",
        message: /\/password/.test(loc)
          ? "The storefront is password protected, so the public page cannot be checked."
          : "The storefront redirected the request, so the page could not be checked.",
      };
    } else if (!res.ok) {
      result = { status: "UNAVAILABLE", message: `The storefront returned HTTP ${res.status}.` };
    } else {
      const observed = extractHeadSeo((await res.text()).slice(0, 2_000_000));
      const value = observed[cfg.field];
      const reflected =
        cfg.field === "title" ? Boolean(value && value.includes(approved.value)) : value === approved.value;
      // Same thresholds as the audit tool's SEO detector.
      const detectorPasses =
        cfg.field === "title"
          ? Boolean(value) && value.length >= 15 && value.length <= 65
          : Boolean(value) && value.length >= 50 && value.length <= 165;
      result = {
        status: reflected ? "REFLECTED" : "NOT_REFLECTED",
        detectorPasses,
        observed: cleanLine(value ?? "", 400),
        message: reflected
          ? detectorPasses
            ? "The public page shows the approved value and passes the audit's check."
            : "The public page shows the approved value, but the rendered tag still falls outside the audit's recommended length (your theme may add text)."
          : "The public page does not show the approved value yet. Storefront caching can take a few minutes.",
      };
    }
  } catch {
    result = { status: "UNAVAILABLE", message: "The storefront could not be reached." };
  }
  const record = { ...result, url, checkedAt: new Date().toISOString() };
  await db.fixExecution.update({ where: { id: plan.id }, data: { liveCheckJson: JSON.stringify(record) } });
  return record;
}
