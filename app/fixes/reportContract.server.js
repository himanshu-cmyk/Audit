// Source report contract (the Node audit tool's schemaVersion 1 JSON) and the
// structural guard applied to every uploaded file before any field is read.
//
// Everything in a report is untrusted. The report describes a sampled, lab-style
// crawl: findings are aggregated by issue id across pages, evidence lines are
// deduplicated and no longer tied to a page, URLs are the requested (not final)
// URLs, and scores/autoApplicable/risk are advisory. Nothing in here can make a
// finding executable; that is decided by the server-side fix registry.

import crypto from "crypto";

export const CONTRACT_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS = [1];

// Structural limits, checked on the parsed value before normalisation.
export const STRUCTURE_LIMITS = {
  maxDepth: 16,
  maxArrayLength: 5000,
  maxStringLength: 200_000,
  maxKeysPerObject: 500,
  maxNodes: 250_000,
};

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Issue ids the source tool emits. Anything else stays visible as unsupported.
export const KNOWN_SOURCE_IDS = new Set([
  "seo.title.missing",
  "seo.title.length",
  "seo.meta-description.missing",
  "seo.meta-description.length",
  "seo.h1.missing",
  "seo.h1.multiple",
  "seo.img.alt-missing",
  "seo.canonical.missing",
  "seo.og.missing",
  "seo.structured-data.missing",
  "seo.lang.missing",
  "perf.cwv.lcp",
  "perf.cwv.lcp-lazy",
  "perf.cwv.cls",
  "perf.cwv.cls-unsized-images",
  "perf.cwv.inp-tbt",
  "perf.weight.total",
  "perf.weight.js",
  "perf.weight.img",
  "perf.img.oversized",
  "perf.load.slow",
  "perf.requests.many",
  "links.broken",
  "links.unverified",
  "shopify.not-detected",
  "shopify.app-bloat",
  "shopify.favicon.missing",
  "trust.https.missing",
  "trust.mixed-content",
  "trust.policies.missing",
  "js.heavy-at-load",
  "fonts.too-many",
  "fonts.heavy",
  "code.render-blocking",
  "code.console-errors",
  "code.dom-size",
  "code.responsive-images",
  "code.inline-styles",
  // Produced only by this app's own audit (app/audit/engine.server.js).
  "admin.media.alt-missing",
  "admin.collection-image.alt-missing",
  "catalog.product.no-images",
  "catalog.product.thin-description",
  "catalog.product.zero-price",
  "catalog.collection.empty",
  "seo.title.duplicate",
  "seo.meta-description.duplicate",
  "shopify.store.password-protected",
  "shopify.themes.unused",
  "trust.domain.custom-missing",
  "trust.contact.missing",
  "links.menu-broken",
]);
const AXE_ID_RE = /^a11y\.[a-z0-9][a-z0-9-]{0,80}$/;

export function isKnownSourceId(id) {
  return typeof id === "string" && (KNOWN_SOURCE_IDS.has(id) || AXE_ID_RE.test(id));
}

// What each kind of report evidence can and cannot prove. Shown with findings.
export function sourceLimitations(id, origin = null) {
  const notes = [];
  if (typeof id !== "string") return notes;
  if (origin) {
    if (origin.includes("admin")) notes.push("Read directly from Shopify Admin data for the listed products and collections.");
    if (origin.includes("theme")) notes.push("Read from the published theme's files.");
    if (origin.includes("storefront")) notes.push("Checked in static storefront HTML fetched by this app (no browser, scripts not run, sampled pages only).");
    if (id === "seo.img.alt-missing") notes.push("Storefront <img> tags without alt can come from the theme or apps, not only product media.");
    return notes;
  }
  if (id.startsWith("perf.") || id.startsWith("js.") || id.startsWith("fonts.") || id.startsWith("code.")) {
    notes.push("Browser lab observation from one sampled crawl, not Lighthouse, PageSpeed Insights or field (CrUX) data.");
  }
  if (id.startsWith("perf.cwv.")) {
    notes.push("Core Web Vitals in this report are homepage-only. CLS is a simple sum of observed shifts and blocking time is a sum of long tasks; INP was not measured.");
  }
  if (id === "js.heavy-at-load") notes.push("Unused JavaScript was measured before any interaction and does not prove the code can be removed.");
  if (id === "shopify.app-bloat") notes.push("Counts third-party script hosts; it does not identify which installed app loads them.");
  if (id === "trust.policies.missing") notes.push("Reflects missing policy-link patterns on the homepage, not whether the policies exist.");
  if (["seo.canonical.missing", "seo.og.missing", "seo.structured-data.missing", "seo.lang.missing"].includes(id)) {
    notes.push("A presence check of the rendered page only.");
  }
  if (id.startsWith("seo.title") || id.startsWith("seo.meta-description")) {
    notes.push("Measured on rendered storefront HTML. A missing or short tag does not prove the Shopify Admin field is empty; the app checks Admin data before proposing a change.");
  }
  if (id === "seo.img.alt-missing" || id === "a11y.image-alt") {
    notes.push("Counts and selector samples do not identify which Shopify media file an image comes from.");
  }
  return notes;
}

export class StructureError extends Error {}

/**
 * Walks a parsed JSON value and enforces depth, size and key limits. Rejects
 * prototype-polluting keys anywhere in the document.
 */
export function assertSafeStructure(value, limits = STRUCTURE_LIMITS) {
  let nodes = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (++nodes > limits.maxNodes) throw new StructureError("The file has too many values.");
    if (depth > limits.maxDepth) throw new StructureError(`The file is nested more than ${limits.maxDepth} levels deep.`);
    if (typeof v === "string") {
      if (v.length > limits.maxStringLength) throw new StructureError("The file contains a text value that is too long.");
    } else if (Array.isArray(v)) {
      if (v.length > limits.maxArrayLength) throw new StructureError(`The file contains a list longer than ${limits.maxArrayLength} items.`);
      for (const x of v) stack.push([x, depth + 1]);
    } else if (v !== null && typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length > limits.maxKeysPerObject) throw new StructureError("The file contains an object with too many keys.");
      for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k)) throw new StructureError(`The file contains a forbidden key ("${k}").`);
        stack.push([v[k], depth + 1]);
      }
    }
  }
}

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Normalises a URL for fingerprinting: lower-case host, no fragment, no trailing slash. */
export function fingerprintUrl(href) {
  try {
    const u = new URL(href);
    u.hash = "";
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return String(href);
  }
}

/**
 * Stable finding id: the same issue id, affected pages and evidence always give
 * the same id, regardless of URL order or which file it was imported from.
 */
export function stableFindingId(sourceId, affectedUrls, evidence) {
  const urls = [...new Set((affectedUrls || []).map(fingerprintUrl))].sort();
  return `f_${sha256(canonicalJson([sourceId, urls, evidence ?? ""])).slice(0, 24)}`;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v, d = 0) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Homepage-only lab metrics from cwv and cdpMetrics, reduced to plain numbers
 * and short labels. Returns { metrics, errors }.
 */
export function readHomepageMetrics(data) {
  const errors = [];
  for (const k of ["cwv", "cdpMetrics"]) {
    if (data[k] !== undefined && data[k] !== null && !isObj(data[k])) errors.push(`"${k}" must be an object or null.`);
  }
  const cwv = isObj(data.cwv) ? data.cwv : null;
  const cdp = isObj(data.cdpMetrics) ? data.cdpMetrics : null;
  if (!cwv && !cdp) return { metrics: null, errors };
  const lcp = cwv && isObj(cwv.lcp) ? cwv.lcp : null;
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  return {
    errors,
    metrics: {
      scope: "homepage",
      fcpMs: round(num(cwv?.fcp)),
      lcpMs: round(num(lcp?.renderTime) || num(lcp?.startTime)),
      lcpElement: lcp
        ? {
            tagName: str(lcp.tagName, 20),
            isLazyLoaded: lcp.isLazyLoaded === true,
            hasFetchPriorityHigh: lcp.hasFetchPriorityHigh === true,
          }
        : null,
      cls: round(num(cwv?.cls), 3),
      clsEntryCount: Array.isArray(cwv?.clsEntries) ? cwv.clsEntries.length : null,
      longTaskCount: Array.isArray(cwv?.longTasks) ? cwv.longTasks.length : null,
      blockingTimeMs: round(num(cwv?.tbt)),
      cdp: cdp
        ? {
            taskDurationMs: round(num(cdp.taskDuration)),
            scriptDurationMs: round(num(cdp.scriptDuration)),
            layoutDurationMs: round(num(cdp.layoutDuration)),
            recalcStyleDurationMs: round(num(cdp.recalcStyleDuration)),
            jsHeapUsedKb: round(num(cdp.jsHeapUsedSize)),
          }
        : null,
    },
  };
}

const sameCounts = (a, b) => ["critical", "high", "medium", "low"].every((k) => a?.[k] === b?.[k]);
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Compares the report's duplicated summaries with each other and with the
 * findings. Returns human-readable notes; scores are never used for decisions.
 */
export function summaryConsistency(data, rawFindings) {
  const notes = [];
  const s = isObj(data.summary) ? data.summary : null;
  if (!s) {
    notes.push("The report has no summary block.");
    return notes;
  }
  const computed = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of rawFindings) if (isObj(f) && f.severity in computed) computed[f.severity]++;
  if (s.overall !== data.overall) notes.push("summary.overall differs from the top-level overall score.");
  if (s.grade !== data.grade) notes.push("summary.grade differs from the top-level grade.");
  if (!sameCounts(s.counts, data.counts)) notes.push("summary.counts differs from the top-level counts.");
  if (!sameCounts(data.counts, computed)) notes.push("The severity counts do not match the findings in the file.");
  if (s.totalFindings !== rawFindings.length) notes.push(`summary.totalFindings (${String(s.totalFindings)}) does not match the ${rawFindings.length} findings in the file.`);
  if (!sameList(s.pagesCrawled, data.pagesCrawled)) notes.push("summary.pagesCrawled differs from the top-level pagesCrawled.");
  const auto = rawFindings.filter((f) => isObj(f) && isObj(f.fix) && f.fix.autoApplicable === true).length;
  if (s.autoApplicableFixes !== auto) notes.push("summary.autoApplicableFixes does not match the findings. (The source's autoApplicable flag is advisory and never used here.)");
  return notes;
}
