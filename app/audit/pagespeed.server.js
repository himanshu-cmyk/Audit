// Optional Google PageSpeed Insights (PSI) measurement of the storefront homepage.
// Google's servers load the page with Lighthouse, so this app runs no browser.
//
// What is sent to Google: only the public homepage URL of the shop being audited.
// The API key (PAGESPEED_API_KEY) stays on the server: it is sent in a request
// header, never in the URL, and never returned to the browser or logged.
//
// Limits: Google cannot get past storefront password protection (the API takes
// only a URL), so a password-protected store is measured by lighthouse.server.js
// instead, or reported as not checked (never as the password page's own score). Field (real-user) data exists only for sites with enough
// Chrome traffic. Missing metrics are reported as unavailable, never as 0.

import { CHECK_STATUS } from "./storefrontClient.server";

export const PSI_ENDPOINT = "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";

export function readPagespeedConfig(env = process.env) {
  const strategy = String(env.PAGESPEED_STRATEGY || "MOBILE").toUpperCase();
  const timeout = Number.parseInt(env.PAGESPEED_TIMEOUT_MS, 10);
  return {
    enabled: Boolean(env.PAGESPEED_API_KEY),
    apiKey: env.PAGESPEED_API_KEY || "",
    strategy: ["MOBILE", "DESKTOP"].includes(strategy) ? strategy : "MOBILE",
    timeoutMs: Number.isFinite(timeout) ? Math.min(90_000, Math.max(10_000, timeout)) : 60_000,
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v, d = 0) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

// Strips query strings and fragments from URLs in evidence (they can carry tokens).
const safeUrl = (u) => {
  try {
    const x = new URL(String(u));
    return `${x.origin}${x.pathname}`.slice(0, 200);
  } catch {
    return String(u || "").split(/[?#]/)[0].slice(0, 200);
  }
};

function fieldMetric(metrics, name, scale = 1) {
  const m = metrics?.[name];
  const p = num(m?.percentile);
  return p === null ? null : { p75: round(p / scale, scale === 1 ? 0 : 3), category: typeof m.category === "string" ? m.category : null };
}

// Query strings are stripped from any URL so tokens in links never reach the report.
const oneLine = (s, n) =>
  String(s || "")
    .replace(/https?:\/\/[^\s"'<>)]+/g, (u) => safeUrl(u))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

// One affected element: its label, CSS selector, HTML snippet and axe's
// explanation (for colour contrast this holds the measured ratio and colours).
function nodeEvidence(item) {
  const n = item?.node;
  if (!n || typeof n !== "object") return null;
  const parts = [
    n.nodeLabel && `"${oneLine(n.nodeLabel, 60)}"`,
    n.selector && `selector ${oneLine(n.selector, 120)}`,
    n.snippet && `html ${oneLine(n.snippet, 160)}`,
    n.explanation && oneLine(String(n.explanation).split("\n").slice(0, 2).join(" "), 220),
  ].filter(Boolean);
  return parts.length ? `- ${parts.join(" · ")}` : null;
}

function lcpElement(x) {
  // Lighthouse 10+ nests the element table inside a list; older versions do not.
  const items = x?.details?.items || [];
  const table = items.find((i) => i?.type === "table") || x?.details;
  const node = (table?.items || []).find((i) => i?.node)?.node;
  const e = node ? nodeEvidence({ node }) : null;
  return e ? e.slice(2) : null;
}

// Where the Lighthouse run happened: on Google's servers (PSI) or in this app's
// own headless Chrome (used when the storefront is unlocked with its password).
export const LIGHTHOUSE_SOURCES = {
  psi: { id: "pagespeed-insights", name: "PageSpeed Insights", where: "on Google's servers" },
  local: { id: "lighthouse-local", name: "Lighthouse", where: "in the app's own Chrome, logged in with the storefront password" },
};

/** Pure parser for a PSI v5 response. Returns { status, ...result } and finding inputs. */
export function parsePagespeed(json, { requestedUrl, strategy, source = LIGHTHOUSE_SOURCES.psi }) {
  const lh = json?.lighthouseResult;
  if (!lh || typeof lh !== "object" || typeof lh.audits !== "object") {
    return { status: CHECK_STATUS.ERROR, message: `${source.name} returned an unexpected response.`, findings: [] };
  }
  const finalUrl = typeof lh.finalUrl === "string" ? lh.finalUrl : typeof lh.finalDisplayedUrl === "string" ? lh.finalDisplayedUrl : null;
  if (finalUrl && /\/password\/?$/.test(new URL(finalUrl, requestedUrl).pathname)) {
    return {
      status: CHECK_STATUS.NOT_CHECKED,
      message: `${source.name} was redirected to the storefront password page, so the real store could not be measured.`,
      findings: [],
    };
  }
  const a = lh.audits;
  const audit = (id) => (a[id] && typeof a[id] === "object" ? a[id] : null);
  const value = (id) => num(audit(id)?.numericValue);
  const lab = {
    performanceScore: num(lh.categories?.performance?.score) === null ? null : Math.round(lh.categories.performance.score * 100),
    accessibilityScore: num(lh.categories?.accessibility?.score) === null ? null : Math.round(lh.categories.accessibility.score * 100),
    lcpMs: round(value("largest-contentful-paint")),
    fcpMs: round(value("first-contentful-paint")),
    cls: round(value("cumulative-layout-shift"), 3),
    tbtMs: round(value("total-blocking-time")),
  };
  const le = json.loadingExperience;
  const metrics = le && typeof le.metrics === "object" ? le.metrics : null;
  const field = metrics
    ? {
        scope: le.origin_fallback === true ? "origin" : "page",
        overall: typeof le.overall_category === "string" ? le.overall_category : null,
        lcpMs: fieldMetric(metrics, "LARGEST_CONTENTFUL_PAINT_MS"),
        fcpMs: fieldMetric(metrics, "FIRST_CONTENTFUL_PAINT_MS"),
        inpMs: fieldMetric(metrics, "INTERACTION_TO_NEXT_PAINT"),
        cls: fieldMetric(metrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE", 100),
      }
    : null;

  const opportunities = Object.values(a)
    .filter((x) => x?.details?.type === "opportunity" && num(x.score) !== null && x.score < 0.9 && num(x.details.overallSavingsMs) > 0)
    .sort((x, y) => y.details.overallSavingsMs - x.details.overallSavingsMs)
    .slice(0, 5)
    .map((x) => ({ id: String(x.id).slice(0, 80), title: String(x.title || "").slice(0, 160), savingsMs: Math.round(x.details.overallSavingsMs) }));

  const findings = [];
  const src = `${source.name} (Lighthouse lab, ${strategy.toLowerCase()})`;
  if (lab.lcpMs !== null && lab.lcpMs > 2500) {
    const el = lcpElement(audit("largest-contentful-paint-element"));
    findings.push({
      id: "perf.cwv.lcp",
      severity: lab.lcpMs > 4000 ? "high" : "medium",
      evidence: `${src}: LCP ${(lab.lcpMs / 1000).toFixed(2)}s (target ≤ 2.5s)${el ? `\nLCP element: ${el}` : "\nLCP element: not reported by PageSpeed"}${
        opportunities.length ? `\nBiggest measured opportunities: ${opportunities.slice(0, 3).map((o) => `${o.title} (~${(o.savingsMs / 1000).toFixed(1)}s)`).join("; ")}` : ""
      }`,
    });
  }
  if (lab.cls !== null && lab.cls > 0.1) {
    findings.push({ id: "perf.cwv.cls", severity: lab.cls > 0.25 ? "high" : "medium", evidence: `${src}: CLS ${lab.cls} (target ≤ 0.1)` });
  }
  if (lab.tbtMs !== null && lab.tbtMs > 200) {
    findings.push({ id: "perf.cwv.inp-tbt", severity: lab.tbtMs > 600 ? "high" : "medium", evidence: `${src}: Total Blocking Time ${lab.tbtMs} ms (target ≤ 200 ms)` });
  }
  if (field?.inpMs && field.inpMs.p75 > 200) {
    findings.push({ id: "perf.cwv.inp-tbt", severity: field.inpMs.p75 > 500 ? "high" : "medium", evidence: `Real users (Chrome UX Report, ${field.scope}): INP p75 ${field.inpMs.p75} ms (target ≤ 200 ms)` });
  }
  // Accessibility audits that failed (axe-core rules run by Lighthouse).
  const a11yRefs = lh.categories?.accessibility?.auditRefs;
  for (const ref of Array.isArray(a11yRefs) ? a11yRefs : []) {
    const x = audit(ref?.id);
    if (!x || x.scoreDisplayMode !== "binary" || x.score !== 0 || !/^[a-z0-9-]{2,80}$/.test(String(ref.id))) continue;
    const items = (x.details?.items || []).slice(0, 5).map(nodeEvidence).filter(Boolean);
    findings.push({
      id: `a11y.${ref.id}`,
      severity: ref.id === "color-contrast" ? "high" : "medium",
      title: String(x.title || ref.id).slice(0, 200),
      evidence: `${src}: ${(x.details?.items || []).length} element(s)${items.length ? `\n${items.join("\n")}` : ""}`,
    });
  }
  const consoleErrors = audit("errors-in-console");
  if (consoleErrors && consoleErrors.score === 0) {
    const items = (consoleErrors.details?.items || [])
      .slice(0, 5)
      .map((i) => {
        const where = typeof i?.sourceLocation?.url === "string" ? ` (in ${safeUrl(i.sourceLocation.url)})` : "";
        return `${String(i?.source || "error").slice(0, 30)}: ${String(i?.description || "").replace(/https?:\/\/\S+/g, (u) => safeUrl(u)).slice(0, 200)}${where}`;
      });
    findings.push({ id: "code.console-errors", severity: "medium", evidence: `${src}: browser errors logged to the console\n${items.join("\n")}` });
  }

  return {
    status: CHECK_STATUS.CHECKED,
    message: `Homepage measured by ${source === LIGHTHOUSE_SOURCES.psi ? "Google PageSpeed Insights" : `Lighthouse ${source.where}`} (${strategy.toLowerCase()}).`,
    source: source.id,
    strategy,
    testedUrl: safeUrl(requestedUrl),
    finalUrl: finalUrl ? safeUrl(finalUrl) : null,
    fetchTime: typeof lh.fetchTime === "string" ? lh.fetchTime.slice(0, 40) : null,
    lab,
    field,
    opportunities,
    limitations: [
      `Lab metrics come from one simulated Lighthouse run ${source.where} and vary between runs.`,
      field ? `Real-user data is the Chrome UX Report 75th percentile for the ${field.scope} over the last 28 days.` : "No real-user (field) data is available for this store.",
      "Interaction to Next Paint (INP) is only available from real-user data; Total Blocking Time is the lab substitute.",
      "Automated accessibility checks find some issues only; they do not prove WCAG compliance.",
    ],
    findings,
  };
}

/** Calls PSI for the homepage. Never throws: failures come back as a status. */
export async function measureHomepage({ url, env = process.env, fetchImpl = fetch }) {
  const cfg = readPagespeedConfig(env);
  if (!cfg.enabled) {
    return { status: CHECK_STATUS.NOT_MEASURED, message: "Speed, colour contrast and JavaScript errors were not measured: PageSpeed Insights is not configured (PAGESPEED_API_KEY).", findings: [] };
  }
  const q = new URLSearchParams({ url, strategy: cfg.strategy });
  for (const c of ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES"]) q.append("category", c);
  let res;
  try {
    res = await fetchImpl(`${PSI_ENDPOINT}?${q}`, {
      headers: { "x-goog-api-key": cfg.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { status: CHECK_STATUS.ERROR, message: timeout ? "PageSpeed Insights did not answer in time." : "PageSpeed Insights could not be reached.", findings: [] };
  }
  if (res.status === 429) return { status: CHECK_STATUS.RATE_LIMITED, message: "PageSpeed Insights quota or rate limit reached. Try again later.", findings: [] };
  if (res.status === 400 || res.status === 403) {
    return { status: CHECK_STATUS.ERROR, message: `PageSpeed Insights refused the request (HTTP ${res.status}): check the API key and that the PageSpeed Insights API is enabled for it, or the page could not be loaded by Google.`, findings: [] };
  }
  if (!res.ok) return { status: CHECK_STATUS.ERROR, message: `PageSpeed Insights returned HTTP ${res.status}.`, findings: [] };
  let json;
  try {
    json = await res.json();
  } catch {
    return { status: CHECK_STATUS.ERROR, message: "PageSpeed Insights returned an unreadable response.", findings: [] };
  }
  return parsePagespeed(json, { requestedUrl: url, strategy: cfg.strategy });
}
