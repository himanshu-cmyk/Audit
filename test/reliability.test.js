/* eslint-env node */
// Storefront request management (429/403/retries/caching/redirects), policy
// permission handling, PageSpeed Insights parsing, and score integrity. All
// network access is mocked; nothing here talks to Shopify or Google.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { measureHomepage, parsePagespeed } from "../app/audit/pagespeed.server";
import { backoffMs, CHECK_STATUS, createStorefrontClient, retryAfterMs } from "../app/audit/storefrontClient.server";
import { safeFetchText } from "../app/fixes/safeFetch.server";
import { createInAppAudit, findingsOf } from "../app/fixes/service.server";
import { createFakeShop } from "./helpers/fakeShopify";
import { createTestDb } from "./helpers/testDb";

const HOST = "rel-store.example.com";
const HTML = `<html lang="en"><head><title>A good title for the store</title><meta name="description" content="${"d".repeat(80)}"><link rel="canonical" href="/"><meta property="og:title" content="x"><script type="application/ld+json">{}</script></head><body><main><h1>Hi</h1><a href="/pages/a">A</a><a href="/pages/b">B</a><input id="q"></main></body></html>`;
const ok = (text = HTML) => ({ status: 200, headers: {}, text });
const status = (code, headers = {}) => ({ status: code, headers, text: "" });
const noSleep = vi.fn(async () => {});

describe("storefront request client", () => {
  const limits = { maxRequests: 40, maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 10_000, cacheTtlMs: 60_000 };

  it("parses Retry-After as seconds or an HTTP date, and ignores invalid values", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });

  it("uses capped exponential backoff with jitter", () => {
    expect(backoffMs(0, limits, () => 0)).toBe(500);
    expect(backoffMs(0, limits, () => 1)).toBe(1000);
    expect(backoffMs(10, limits, () => 1)).toBe(10_000); // capped
  });

  it("honours Retry-After on 429 and then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const fetchPage = vi.fn().mockResolvedValueOnce(status(429, { retryAfter: "2" })).mockResolvedValueOnce(ok());
    const c = createStorefrontClient({ fetchPage, limits, sleep });
    expect((await c.request("https://x/a")).status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(c.stopped).toBeNull();
    expect(c.stats()).toMatchObject({ requests: 2, retries: 1 });
  });

  it("backs off without Retry-After, stops after the retry limit, then makes no more requests", async () => {
    const sleep = vi.fn(async () => {});
    const fetchPage = vi.fn(async () => status(429, { server: "cloudflare" }));
    const c = createStorefrontClient({ fetchPage, limits, sleep, random: () => 0 });
    expect((await c.request("https://x/a")).status).toBe(429);
    expect(fetchPage).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(sleep.mock.calls.map((x) => x[0])).toEqual([500, 1000]);
    expect(c.stopped).toMatchObject({ kind: "rate_limited", status: 429, server: "cloudflare" });
    expect(await c.request("https://x/b")).toMatchObject({ skipped: true });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("does not wait for a Retry-After longer than the audit allows", async () => {
    const sleep = vi.fn(async () => {});
    const fetchPage = vi.fn(async () => status(429, { retryAfter: "120" }));
    const c = createStorefrontClient({ fetchPage, limits, sleep });
    await c.request("https://x/a");
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(c.stopped.kind).toBe("rate_limited");
  });

  it("never retries 403, 404 or other client errors; 403 stops the client", async () => {
    const f404 = vi.fn(async () => status(404));
    const c1 = createStorefrontClient({ fetchPage: f404, limits, sleep: noSleep });
    await c1.request("https://x/a");
    expect(f404).toHaveBeenCalledTimes(1);
    expect(c1.stopped).toBeNull();
    const f403 = vi.fn(async () => status(403));
    const c2 = createStorefrontClient({ fetchPage: f403, limits, sleep: noSleep });
    await c2.request("https://x/a");
    expect(f403).toHaveBeenCalledTimes(1);
    expect(c2.stopped.kind).toBe("blocked");
  });

  it("serves duplicate GETs from the per-audit cache, keyed by cookie", async () => {
    const fetchPage = vi.fn(async () => ok());
    const c = createStorefrontClient({ fetchPage, limits, sleep: noSleep });
    await c.request("https://x/a", { headers: {} });
    await c.request("https://x/a", { headers: {} });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await c.request("https://x/a", { headers: { cookie: "storefront_digest=1" } });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(c.stats().cacheHits).toBe(1);
  });

  it("enforces the total request budget", async () => {
    const fetchPage = vi.fn(async (u) => ok(u));
    const c = createStorefrontClient({ fetchPage, limits: { ...limits, maxRequests: 3 }, sleep: noSleep });
    for (let i = 0; i < 5; i++) await c.request(`https://x/${i}`);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(c.stopped.kind).toBe("budget");
  });
});

describe("safe fetch timeouts", () => {
  it("turns a hung request into a TIMEOUT error", async () => {
    const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    await expect(safeFetchText(`https://${HOST}/`, { allowedHosts: [HOST], timeoutMs: 50, requestOnce: hang })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("re-validates redirect destinations when following redirects", async () => {
    const hop = vi.fn().mockResolvedValueOnce(status(301, { location: "https://10.0.0.8/" }));
    await expect(safeFetchText(`https://${HOST}/`, { allowedHosts: [HOST, "10.0.0.8"], maxRedirects: 2, requestOnce: hop })).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
  });
});

// ------------------------------------------------------------ whole audit

let testDb;
let db;
beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
});
afterAll(async () => testDb.cleanup());

let fake;
let base;
let n = 0;
beforeEach(() => {
  fake = createFakeShop({ shop: "rel.myshopify.com", primaryHost: HOST });
  base = { db, admin: fake.admin, session: { ...fake.session, shop: `rel-${n++}-${Math.random().toString(36).slice(2, 6)}.myshopify.com` } };
  fake.api.addTheme({ name: "Horizon", role: "MAIN", files: { "layout/theme.liquid": '<html lang="en"><head><link rel="canonical" href="{{ canonical_url }}"></head></html>' } });
  fake.state.policies = [{ type: "PRIVACY_POLICY", body: "x" }, { type: "REFUND_POLICY", body: "x" }, { type: "TERMS_OF_SERVICE", body: "x" }, { type: "SHIPPING_POLICY", body: "x" }];
});
const fastClient = { sleep: async () => {} };
const audit = (extra = {}) => createInAppAudit({ ...base, ...extra });
const reportOf = (imp) => JSON.parse(imp.reportJson);
const ids = (imp) => findingsOf(imp).map((f) => f.auditId);

describe("audit with an unreliable storefront", () => {
  it("stops at a 429, keeps every other result, and deducts nothing for it", async () => {
    const fetchPage = vi.fn(async () => status(429));
    const imp = await createInAppAudit({ ...base, fetchPage, storefrontClientOptions: fastClient });
    const r = reportOf(imp);
    expect(r.storefront.status).toBe(CHECK_STATUS.RATE_LIMITED);
    expect(r.storefront.message).toMatch(/rate limited.*HTTP 429/);
    expect(fetchPage).toHaveBeenCalledTimes(3); // homepage + 2 retries, then nothing
    expect(r.policies.status).toBe("checked");
    expect(r.theme.status).toBe("checked");
    expect(r.score.categories.accessibility.score).toBeNull();
    expect(r.score.categories.performance.score).toBeNull();
    expect(r.coverage.find((c) => c.area.startsWith("Storefront")).status).toBe("rate_limited");
    expect(ids(imp)).not.toContain("links.broken");
  });

  it("reports a 403 as blocked, not as a wrong password, with one request", async () => {
    const fetchPage = vi.fn(async () => status(403, { server: "cloudflare" }));
    const r = reportOf(await createInAppAudit({ ...base, fetchPage, storefrontClientOptions: fastClient }));
    expect(r.storefront).toMatchObject({ status: "blocked", stopped: { kind: "blocked", status: 403, server: "cloudflare" } });
    expect(r.storefront.message).toMatch(/refused the app's requests \(HTTP 403\) \(answered by "cloudflare"\)/);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("never reports rate-limited link checks as broken links", async () => {
    const fetchPage = vi.fn(async (url) => (new URL(url).pathname === "/" ? ok() : status(429)));
    const imp = await createInAppAudit({ ...base, fetchPage, storefrontClientOptions: fastClient });
    const r = reportOf(imp);
    expect(ids(imp)).not.toContain("links.broken");
    expect(r.storefront.status).toBe(CHECK_STATUS.PARTIAL);
    expect(r.storefront.message).toMatch(/could not be confirmed/);
    // The homepage that did load still produced findings and is scored.
    expect(ids(imp)).toContain("a11y.label");
    expect(r.score.categories.accessibility.score).not.toBeNull();
  });

  it("reports only 404 / 410 links as broken", async () => {
    const fetchPage = vi.fn(async (url) => {
      const p = new URL(url).pathname;
      return p === "/" ? ok() : p === "/pages/a" ? status(404) : status(500);
    });
    const imp = await createInAppAudit({ ...base, fetchPage, storefrontClientOptions: fastClient });
    const broken = findingsOf(imp).find((f) => f.auditId === "links.broken");
    expect(broken.evidence).toBe("/ links to /pages/a (HTTP 404)");
  });

  it("follows same-store redirects but not redirects to other hosts", async () => {
    fake.api.addProduct({ title: "Moved product", handle: "old", description: "", images: [] });
    const fetchPage = vi.fn(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/products/old") return status(301, { location: "/products/new" });
      if (u.pathname === "/products/new") return ok(HTML.replace("<h1>Hi</h1>", "<h1>A</h1><h1>B</h1>"));
      if (u.pathname.startsWith("/pages/")) return status(301, { location: "https://evil.example/x" });
      return ok();
    });
    const imp = await createInAppAudit({ ...base, fetchPage, storefrontClientOptions: fastClient });
    expect(fetchPage.mock.calls.some(([u]) => u.startsWith("https://evil.example"))).toBe(false);
    expect(findingsOf(imp).find((f) => f.auditId === "seo.h1.multiple").evidence).toMatch(/products\/old/);
    expect(reportOf(imp).storefront.status).toBe("checked");
  });
});

describe("store policies and permissions", () => {
  it("is not checked when Shopify has not granted the scope (no policy query sent)", async () => {
    fake.state.grantedScopes = ["write_products", "read_themes"];
    const r = reportOf(await audit({ includeStorefront: false }));
    expect(r.policies).toMatchObject({ status: "not_checked", reason: "missing_scope" });
    expect(r.grantedScopesSource).toBe("shopify");
    expect(fake.state.calls.some((c) => c.name === "StoreAuditShopPolicies")).toBe(false);
  });

  it("trusts Shopify's granted scopes over a stale session", async () => {
    const r = reportOf(await audit({ includeStorefront: false, session: { ...base.session, scope: "write_products" } }));
    expect(r.policies.status).toBe("checked");
  });

  it("classifies a permission error separately from other GraphQL errors", async () => {
    fake.state.interceptors.StoreAuditShopPolicies = () => new Response(JSON.stringify({ errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] }));
    const denied = await audit({ includeStorefront: false });
    expect(reportOf(denied).policies).toMatchObject({ status: "not_checked", reason: "access_denied" });
    fake.state.interceptors.StoreAuditShopPolicies = () => new Response(JSON.stringify({ errors: [{ message: "Internal error" }] }));
    const failed = await audit({ includeStorefront: false, session: { ...base.session, shop: `${base.session.shop}-2` } });
    expect(reportOf(failed).policies).toMatchObject({ status: "error" });
    // A failed read is never reported as missing policies.
    expect(ids(denied)).not.toContain("trust.policies.missing");
    expect(ids(failed)).not.toContain("trust.policies.missing");
    expect(reportOf(failed).score.categories.trust.score).toBeNull();
  });

  it("reports empty policies when the read succeeds", async () => {
    fake.state.policies = [{ type: "PRIVACY_POLICY", body: "<p> </p>" }];
    const imp = await audit({ includeStorefront: false });
    expect(findingsOf(imp).find((f) => f.auditId === "trust.policies.missing").instances).toBe(4);
  });
});

// ------------------------------------------------------------ PageSpeed

const PSI_KEY = "psi-test-key-not-real";
function psiResponse({ field = true, lcp = 4200, cls = 0.05, tbt = 350, contrast = true, consoleError = true, finalUrl = `https://${HOST}/` } = {}) {
  const audits = {
    "largest-contentful-paint": { id: "largest-contentful-paint", numericValue: lcp },
    "first-contentful-paint": { id: "first-contentful-paint", numericValue: 1800 },
    "cumulative-layout-shift": { id: "cumulative-layout-shift", numericValue: cls },
    "total-blocking-time": { id: "total-blocking-time", numericValue: tbt },
    "render-blocking-resources": { id: "render-blocking-resources", title: "Eliminate render-blocking resources", score: 0.3, details: { type: "opportunity", overallSavingsMs: 900 } },
    "color-contrast": { id: "color-contrast", title: "Background and foreground colors do not have a sufficient contrast ratio.", scoreDisplayMode: "binary", score: contrast ? 0 : 1, details: { items: [{ node: { selector: "a.footer-link" } }] } },
    label: { id: "label", title: "Form elements do not have associated labels", scoreDisplayMode: "binary", score: 0, details: { items: [{ node: { selector: "input#q" } }] } },
    "errors-in-console": { id: "errors-in-console", score: consoleError ? 0 : 1, details: { items: [{ source: "network", description: "Failed to load https://cdn.example/app.js?token=SECRET123" }] } },
  };
  return {
    lighthouseResult: {
      finalUrl,
      fetchTime: "2026-10-28T10:00:00.000Z",
      categories: {
        performance: { score: 0.62 },
        accessibility: { score: 0.81, auditRefs: [{ id: "color-contrast" }, { id: "label" }] },
      },
      audits,
    },
    ...(field
      ? { loadingExperience: { origin_fallback: true, overall_category: "AVERAGE", metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900, category: "AVERAGE" }, INTERACTION_TO_NEXT_PAINT: { percentile: 240, category: "AVERAGE" }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 4, category: "FAST" } } } }
      : {}),
  };
}

describe("PageSpeed Insights", () => {
  const env = { PAGESPEED_API_KEY: PSI_KEY };
  const respond = (body, code = 200) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code }));

  it("parses lab and field data separately and creates measured findings", () => {
    const r = parsePagespeed(psiResponse(), { requestedUrl: `https://${HOST}/`, strategy: "MOBILE" });
    expect(r.status).toBe("checked");
    expect(r.lab).toMatchObject({ performanceScore: 62, lcpMs: 4200, fcpMs: 1800, cls: 0.05, tbtMs: 350, accessibilityScore: 81 });
    expect(r.field).toMatchObject({ scope: "origin", lcpMs: { p75: 2900 }, inpMs: { p75: 240 }, cls: { p75: 0.04 } });
    const byId = Object.fromEntries(r.findings.map((f) => [f.id, f]));
    expect(byId["perf.cwv.lcp"].severity).toBe("high");
    expect(byId["perf.cwv.cls"]).toBeUndefined();
    expect(byId["a11y.color-contrast"].evidence).toMatch(/a\.footer-link/);
    // Console evidence never keeps query strings (they can carry tokens).
    expect(byId["code.console-errors"].evidence).not.toContain("SECRET123");
    expect(r.opportunities[0]).toMatchObject({ id: "render-blocking-resources", savingsMs: 900 });
  });

  it("reports missing metrics and field data as unavailable, never 0", () => {
    const json = psiResponse({ field: false });
    delete json.lighthouseResult.audits["largest-contentful-paint"];
    const r = parsePagespeed(json, { requestedUrl: `https://${HOST}/`, strategy: "MOBILE" });
    expect(r.lab.lcpMs).toBeNull();
    expect(r.field).toBeNull();
    expect(r.limitations.join()).toMatch(/No real-user/);
    expect(r.findings.find((f) => f.id === "perf.cwv.lcp")).toBeUndefined();
  });

  it("does not score a store whose PSI run ended on the password page", () => {
    const r = parsePagespeed(psiResponse({ finalUrl: `https://${HOST}/password` }), { requestedUrl: `https://${HOST}/`, strategy: "MOBILE" });
    expect(r.status).toBe("not_checked");
  });

  it("keeps the API key in a header, never in the URL", async () => {
    const fetchImpl = respond(psiResponse());
    await measureHomepage({ url: `https://${HOST}/`, env, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("pagespeedonline.googleapis.com");
    expect(url).not.toContain(PSI_KEY);
    expect(url).toContain("category=PERFORMANCE");
    expect(init.headers["x-goog-api-key"]).toBe(PSI_KEY);
  });

  it("handles quota, refusals, bad JSON, unexpected shapes, timeouts and network failures", async () => {
    const url = `https://${HOST}/`;
    expect((await measureHomepage({ url, env, fetchImpl: respond({}, 429) })).status).toBe("rate_limited");
    expect((await measureHomepage({ url, env, fetchImpl: respond({}, 403) })).message).toMatch(/API key/);
    expect((await measureHomepage({ url, env, fetchImpl: respond("not json") })).status).toBe("error");
    expect((await measureHomepage({ url, env, fetchImpl: respond({ hello: 1 }) })).status).toBe("error");
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect((await measureHomepage({ url, env, fetchImpl: timeout })).message).toMatch(/did not answer in time/);
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await measureHomepage({ url, env, fetchImpl: down })).message).toMatch(/could not be reached/);
    expect((await measureHomepage({ url, env: {}, fetchImpl: down })).status).toBe("not_measured");
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("is merged into the audit, deduplicated with static checks, and never stores the key", async () => {
    const fetchImpl = respond(psiResponse());
    const imp = await createInAppAudit({ ...base, fetchPage: async () => ok(), storefrontClientOptions: fastClient, pagespeedFetch: fetchImpl, env });
    const r = reportOf(imp);
    expect(r.performance).toMatchObject({ status: "checked", source: "pagespeed-insights", strategy: "MOBILE" });
    expect(r.score.categories.performance.score).not.toBeNull();
    // Static scan and Lighthouse both found the unlabeled input: one finding, two sources.
    expect(findingsOf(imp).filter((f) => f.auditId === "a11y.label")).toHaveLength(1);
    expect(findingsOf(imp).find((f) => f.auditId === "a11y.label").origin).toBe("pagespeed+storefront");
    expect(JSON.stringify(await db.auditImport.findUnique({ where: { id: imp.id } }))).not.toContain(PSI_KEY);
  });

  it("is not sent for a password-protected store", async () => {
    fake.state.passwordProtected = true;
    const fetchImpl = respond(psiResponse());
    const r = reportOf(await createInAppAudit({ ...base, fetchPage: async () => ok(), storefrontClientOptions: fastClient, pagespeedFetch: fetchImpl, env }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.performance.status).toBe("not_checked");
    expect(r.coverage.find((c) => c.area.startsWith("Speed")).reason).toMatch(/password protected/);
  });
});
