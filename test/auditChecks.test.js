/* eslint-env node */
// Checks added to the in-app audit: storefront password unlock, static
// accessibility rules, homepage SEO, broken links, favicon, policies and the
// score. Shopify and the storefront are fakes; no network is used.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { passwordForm, scoreAudit } from "../app/audit/engine.server";
import { accessibilityIssues, scanHtml, validAutocomplete } from "../app/audit/html.server";
import { createInAppAudit, findingsOf } from "../app/fixes/service.server";
import { createFakeShop } from "./helpers/fakeShopify";
import { createTestDb } from "./helpers/testDb";

const HOST = "testing-store.myshopify.com";
const SECRET = "correct horse battery";
const LAYOUT = '<html lang="{{ request.locale.iso_code }}"><head>{% render \'meta-tags\' %}</head><body></body></html>';
const SETTINGS = (favicon) => `/*\n * IMPORTANT: auto-generated\n */\n${JSON.stringify({ current: { favicon } })}`;

const HOME = `<!doctype html><html lang="en"><head><title>Testing</title><link rel="canonical" href="/">
<meta property="og:title" content="x"><script type="application/ld+json">{}</script></head>
<body><header><a href="/"><svg></svg></a><button class="menu"></button></header>
<main><h1>Welcome</h1><form><input type="email" name="email" autocomplete="mail"><input id="q" type="search"></form>
<a href="/products/blue-shirt">Shirt</a> <a href="/pages/gone">Old page</a> <a href="https://elsewhere.example/x">out</a>
<div id="dup"></div><div id="dup"></div></main></body></html>`;
const PRODUCT = `<html lang="en"><head><title>Blue Shirt – Testing</title><link rel="canonical" href="/p"><meta name="description" content="A blue shirt"><meta property="og:title" content="x"><script type="application/ld+json">{}</script></head><body><main><h1>Blue Shirt</h1></main></body></html>`;

// Simulates a password-protected Shopify storefront.
function storefront({ password = SECRET } = {}) {
  const calls = [];
  const fetchPage = vi.fn(async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body || null, cookie: opts.headers?.cookie || "" });
    const u = new URL(url);
    const unlocked = /storefront_digest=ok/.test(opts.headers?.cookie || "");
    if (u.pathname === "/password") {
      if (opts.method === "POST") {
        const ok = new URLSearchParams(opts.body).get("password") === password;
        return { status: 302, headers: { location: ok ? `https://${HOST}/` : `https://${HOST}/password`, setCookie: ok ? ["storefront_digest=ok; path=/; HttpOnly"] : [] }, text: "" };
      }
      return {
        status: 200,
        headers: { setCookie: ["_shopify_s=abc; path=/"] },
        text: '<form method="post" action="/password"><input type="hidden" name="form_type" value="storefront_password"><input type="hidden" name="utf8" value="✓"><input type="password" name="password"></form>',
      };
    }
    if (!unlocked) return { status: 302, headers: { location: `https://${HOST}/password` }, text: "" };
    if (u.pathname === "/") return { status: 200, headers: {}, text: HOME };
    if (u.pathname === "/products/blue-shirt") return { status: 200, headers: {}, text: PRODUCT };
    return { status: 404, headers: {}, text: "Not found" };
  });
  return { fetchPage, calls };
}

let testDb;
let db;
beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
});
afterAll(async () => testDb.cleanup());

let fake;
let base;
let live;
beforeEach(() => {
  fake = createFakeShop({ shop: HOST, primaryHost: HOST });
  base = { db, admin: fake.admin, session: { ...fake.session, shop: `t-${Math.random().toString(36).slice(2, 8)}.myshopify.com` } };
  fake.api.addProduct({ title: "Blue Shirt", handle: "blue-shirt", description: "A plain blue cotton shirt with long sleeves, cut for a relaxed everyday fit and easy care." , seoTitle: "Blue Shirt | Cotton, long sleeves" });
  live = fake.api.addTheme({ name: "Dawn", role: "MAIN", files: { "layout/theme.liquid": LAYOUT, "snippets/meta-tags.liquid": '<link rel="canonical" href="{{ canonical_url }}">', "config/settings_data.json": SETTINGS("shopify://shop_images/icon.png") } });
  fake.state.policies = [
    { type: "PRIVACY_POLICY", body: "<p>Privacy</p>" },
    { type: "REFUND_POLICY", body: "" },
    { type: "TERMS_OF_SERVICE", body: "<p>Terms</p>" },
  ];
});

const ids = (imp) => findingsOf(imp).map((f) => f.auditId);
const byId = (imp, id) => findingsOf(imp).find((f) => f.auditId === id);

describe("password-protected storefront", () => {
  it("unlocks with the password for this run only and checks the real pages", async () => {
    const sf = storefront();
    const imp = await createInAppAudit({ ...base, storefrontPassword: SECRET, fetchPage: sf.fetchPage });
    const report = JSON.parse(imp.reportJson);
    expect(report.storefront.status).toBe("checked");
    expect(report.storefront.message).toMatch(/unlocked with the password you entered/);
    // The password went only to the shop's own /password form, in a POST body.
    const withPassword = sf.calls.filter((c) => (c.body || "").includes("password="));
    expect(withPassword).toHaveLength(1);
    expect(withPassword[0]).toMatchObject({ url: `https://${HOST}/password`, method: "POST" });
    expect(new URLSearchParams(withPassword[0].body).get("form_type")).toBe("storefront_password");
    expect(sf.calls.every((c) => new URL(c.url).hostname === HOST)).toBe(true);
    // Never stored anywhere.
    const row = await db.auditImport.findUnique({ where: { id: imp.id } });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it("reports a wrong password without failing the rest of the audit", async () => {
    const imp = await createInAppAudit({ ...base, storefrontPassword: "nope", fetchPage: storefront().fetchPage });
    const report = JSON.parse(imp.reportJson);
    expect(report.storefront).toMatchObject({ status: "not_checked", message: expect.stringMatching(/did not accept the storefront password/) });
    expect(report.theme.status).toBe("checked");
  });

  it("asks for the password when none is given", async () => {
    const imp = await createInAppAudit({ ...base, fetchPage: storefront().fetchPage });
    expect(JSON.parse(imp.reportJson).storefront.message).toMatch(/Enter the storefront password/);
  });
});

describe("password form and blocking (real Shopify page shape)", () => {
  // Shape of a real Shopify password page (2026): a Rails authenticity token,
  // no form_type field, data-remote form.
  const REAL = '<form action="/password" accept-charset="UTF-8" data-remote="true" method="post"><input type="hidden" name="authenticity_token" value="tok&#43;en&#x3D;=" autocomplete="off" /><input type="password" class="form-input " id="password" name="password" autocomplete="nope"></form><form action="/contact" method="post"><input type="hidden" name="form_type" value="customer"><input type="email" name="contact[email]"></form>';

  it("finds the password form by its field and keeps the authenticity token", () => {
    const f = passwordForm(REAL);
    expect(f.action).toBe("/password");
    expect(Object.fromEntries(f.fields)).toEqual({ authenticity_token: "tok+en==" });
    expect(passwordForm("<form><input name=q></form>")).toBeNull();
  });

  it("sends the token, Origin and Referer, and unlocks", async () => {
    const posts = [];
    const fetchPage = vi.fn(async (url, opts = {}) => {
      const u = new URL(url);
      const ok = /storefront_digest=1/.test(opts.headers?.cookie || "");
      if (u.pathname === "/password" && opts.method === "POST") {
        posts.push(opts);
        const body = new URLSearchParams(opts.body);
        const accepted = body.get("authenticity_token") === "tok+en==" && body.get("password") === SECRET && /_shopify_essential=s1/.test(opts.headers.cookie);
        return { status: 302, headers: { location: accepted ? `https://${HOST}/` : `https://${HOST}/password`, setCookie: accepted ? ["storefront_digest=1; path=/"] : [] }, text: "" };
      }
      if (u.pathname === "/password") return { status: 200, headers: { setCookie: ["_shopify_essential=s1; path=/"] }, text: REAL };
      if (!ok) return { status: 302, headers: { location: `https://${HOST}/password` }, text: "" };
      return { status: 200, headers: {}, text: u.pathname === "/" ? HOME : PRODUCT };
    });
    const imp = await createInAppAudit({ ...base, storefrontPassword: SECRET, fetchPage });
    expect(JSON.parse(imp.reportJson).storefront.status).toBe("checked");
    expect(posts[0].headers).toMatchObject({ origin: `https://${HOST}`, referer: `https://${HOST}/password` });
    expect(new URLSearchParams(posts[0].body).has("form_type")).toBe(false);
  });

  it("reports Shopify's bot blocking instead of a wrong password", async () => {
    const blocked = vi.fn(async (url) => (new URL(url).pathname === "/password" ? { status: 403, headers: {}, text: "blocked" } : { status: 302, headers: { location: `https://${HOST}/password` }, text: "" }));
    const imp = await createInAppAudit({ ...base, storefrontPassword: SECRET, fetchPage: blocked });
    const sf = JSON.parse(imp.reportJson).storefront;
    expect(sf.status).toBe("blocked");
    expect(sf.message).toMatch(/refused the automated password login/);
    const allBlocked = vi.fn(async () => ({ status: 403, headers: {}, text: "blocked" }));
    const imp2 = await createInAppAudit({ ...base, session: { ...base.session, shop: `${base.session.shop}b` }, fetchPage: allBlocked });
    expect(JSON.parse(imp2.reportJson).storefront).toMatchObject({ status: "blocked", message: expect.stringMatching(/HTTP 403/) });
  });
});

describe("coverage", () => {
  it("explains what was not checked and does not score unchecked categories", async () => {
    for (const p of fake.state.products.values()) p.status = "DRAFT";
    const imp = await createInAppAudit({ ...base, fetchPage: storefront().fetchPage });
    const report = JSON.parse(imp.reportJson);
    const areas = Object.fromEntries(report.coverage.map((c) => [c.area.split(" ")[0], c]));
    expect(areas.Products.reason).toContain("1 product(s) but none are active (1 draft)");
    expect(areas.Storefront.reason).toMatch(/password protected/);
    expect(report.score.categories.accessibility.score).toBeNull();
    expect(report.scan.productCounts).toEqual({ all: 1, active: 0, draft: 1 });
  });
});

describe("storefront checks on the unlocked pages", () => {
  it("finds homepage SEO, accessibility and broken-link issues", async () => {
    const imp = await createInAppAudit({ ...base, storefrontPassword: SECRET, fetchPage: storefront().fetchPage });
    expect(ids(imp)).toEqual(
      expect.arrayContaining(["seo.title.length", "seo.meta-description.missing", "a11y.link-name", "a11y.button-name", "a11y.label", "a11y.autocomplete-valid", "a11y.duplicate-id", "links.broken"]),
    );
    expect(byId(imp, "seo.title.length").evidence).toMatch(/homepage title is 7 characters \("Testing"\)/);
    expect(byId(imp, "a11y.autocomplete-valid").evidence).toMatch(/name="email"/);
    expect(byId(imp, "links.broken").evidence).toMatch(/\/ links to \/pages\/gone \(HTTP 404\)/);
    // External links are not requested; the product page link works.
    expect(byId(imp, "links.broken").evidence).not.toMatch(/elsewhere|blue-shirt/);
    // The homepage is fixed manually (Online Store > Preferences), never through a product.
    expect(byId(imp, "seo.meta-description.missing").affectedUrls).toEqual([`https://${HOST}/`]);
    // Present on every page: no finding.
    expect(ids(imp)).not.toContain("a11y.landmark-one-main");
    expect(ids(imp)).not.toContain("seo.canonical.missing");
  });
});

describe("theme and Admin checks", () => {
  it("flags a missing favicon, and reads settings with a comment header", async () => {
    live.files["config/settings_data.json"] = SETTINGS("");
    const imp = await createInAppAudit({ ...base, includeStorefront: false });
    expect(ids(imp)).toContain("shopify.favicon.missing");
    expect(ids(imp)).not.toContain("seo.canonical.missing"); // provided by the meta-tags snippet
  });

  it("does not flag the favicon when it is set", async () => {
    const imp = await createInAppAudit({ ...base, includeStorefront: false });
    expect(ids(imp)).not.toContain("shopify.favicon.missing");
  });

  it("lists empty standard policies, and skips the check without the permission", async () => {
    const imp = await createInAppAudit({ ...base, includeStorefront: false });
    expect(byId(imp, "trust.policies.missing").evidence.split("\n")).toEqual(["Refund policy is empty", "Shipping policy is empty"]);
    // Shopify (not the stored session) says the permission is not granted.
    fake.state.grantedScopes = ["write_products", "read_themes"];
    const noScope = await createInAppAudit({ ...base, session: { ...base.session, shop: `${base.session.shop}x` }, includeStorefront: false });
    expect(JSON.parse(noScope.reportJson).policies.status).toBe("not_checked");
    expect(fake.state.calls.filter((c) => c.name === "StoreAuditShopPolicies")).toHaveLength(1);
  });
});

describe("score", () => {
  it("is transparent: fixed points per finding by severity, averaged over checked categories", () => {
    const f = (category, severity) => ({ category, severity });
    const s = scoreAudit([f("seo", "high"), f("seo", "low"), f("accessibility", "critical"), f("trust", "medium")], { seo: true, accessibility: true, trust: true });
    expect(s.categories.seo.score).toBe(82);
    expect(s.categories.accessibility.score).toBe(75);
    expect(s.categories.trust.score).toBe(92);
    expect(s.categories.links.score).toBeNull();
    expect(s.overall).toBe(83);
    expect(s.grade).toBe("B");
    expect(scoreAudit(Array(10).fill(f("seo", "critical")), { seo: true }).categories.seo.score).toBe(0);
  });

  it("is stored with the audit and leaves unchecked categories out", async () => {
    const imp = await createInAppAudit({ ...base, includeStorefront: false });
    const { score } = JSON.parse(imp.reportJson);
    expect(imp.overallScore).toBe(score.overall);
    expect(score.categories.links.score).toBe(100); // menus were checked even without the storefront
    expect(score.categories.performance.score).toBeNull();
  });
});

describe("static HTML accessibility rules", () => {
  it("understands labels, wrapped inputs and image alt inside links", () => {
    const issues = accessibilityIssues(
      scanHtml(
        '<main><label>Email <input type="email"></label><label for="n">Name</label><input id="n"><input type="hidden" name="t"><input aria-label="Search"><a href="/"><img alt="Home"></a><button aria-label="Close"></button><script>document.write("<input>")</script></main>',
      ),
    );
    expect(issues).toEqual({});
  });

  it("validates autocomplete tokens", () => {
    for (const v of ["email", "current-password", "shipping postal-code", "section-a billing tel", "off", ""]) expect(validAutocomplete(v), v).toBe(true);
    for (const v of ["mail", "password", "shipping"]) expect(validAutocomplete(v), v).toBe(false);
  });
});
