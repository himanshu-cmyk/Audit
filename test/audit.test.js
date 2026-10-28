/* eslint-env node */
// In-app audit, one-time theme choice and "prepare all". Shopify is the
// in-memory fake and storefront pages come from an injected fetcher.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeHtml } from "../app/audit/engine.server";
import { EXEC, VERIFY } from "../app/fixes/constants";
import { classifyFinding } from "../app/fixes/registry.server";
import {
  approvePlans,
  createInAppAudit,
  executePlans,
  findingsOf,
  prepareAllFixable,
  prepareFinding,
  setImportTheme,
} from "../app/fixes/service.server";
import { createFakeShop } from "./helpers/fakeShopify";
import { createTestDb } from "./helpers/testDb";

const HOST = "www.example-store.com";
const LAYOUT = '<!doctype html>\n<html class="no-js">\n  <head>\n    <title>{{ page_title }}</title>\n  </head>\n  <body>{{ content_for_layout }}</body>\n</html>';

let testDb;
let db;
beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
});
afterAll(async () => testDb.cleanup());

let fake;
let base;
let draftTheme;
let liveTheme;
let shirt;
beforeEach(() => {
  fake = createFakeShop({ shop: `a-${Math.random().toString(36).slice(2, 8)}.myshopify.com`, primaryHost: HOST });
  base = { db, admin: fake.admin, session: fake.session };
  shirt = fake.api.addProduct({ title: "Blue Shirt", handle: "blue-shirt", description: "", images: [{ alt: "" }, { alt: "IMG_2041.jpg" }, { alt: "Front view of the blue cotton shirt" }] });
  fake.api.addProduct({
    title: "Green Tea",
    handle: "green-tea",
    description: "Loose leaf green tea from a single estate, packed in a resealable 100 g pouch to keep the leaves fresh.",
    seoTitle: "Green Tea | Loose Leaf, 100 g pouch",
  });
  const draft = fake.api.addProduct({ title: "Secret Draft", handle: "secret-draft", description: "" });
  draft.status = "DRAFT";
  fake.api.addCollection({ title: "Shirts", handle: "shirts", description: "" });
  fake.api.addCollection({ title: "All", handle: "all", description: "" });
  liveTheme = fake.api.addTheme({ name: "Dawn", role: "MAIN", files: { "layout/theme.liquid": LAYOUT } });
  draftTheme = fake.api.addTheme({ name: "Dawn copy", role: "UNPUBLISHED", files: { "layout/theme.liquid": LAYOUT } });
});

const writes = () => fake.state.calls.filter((c) => /Update|Upsert|publish/i.test(c.name));
const passwordProtected = vi.fn(async () => ({ status: 302, headers: { location: `https://${HOST}/password` }, text: "" }));

describe("in-app audit", () => {
  it("finds Admin, media and theme issues on the shop's own data without changing anything", async () => {
    const imp = await createInAppAudit({ ...base, fetchPage: passwordProtected });
    expect(imp).toMatchObject({ sourceFormat: "in-app", storeMatch: "MATCHED", auditedHost: HOST, contractVersion: 1 });
    const byId = Object.fromEntries(findingsOf(imp).map((f) => [f.auditId, f]));

    expect(byId["seo.meta-description.missing"].affectedUrls).toEqual([`https://${HOST}/products/blue-shirt`, `https://${HOST}/collections/shirts`]);
    expect(byId["seo.title.length"].affectedUrls).toContain(`https://${HOST}/products/blue-shirt`); // "Blue Shirt" is 10 characters
    expect(byId["admin.media.alt-missing"]).toMatchObject({ instances: 2, origin: "admin" });
    expect(byId["admin.media.alt-missing"].evidence).toMatch(/weak alt "IMG_2041.jpg"/);
    expect(byId["seo.lang.missing"].origin).toBe("theme");
    expect(byId["seo.canonical.missing"].origin).toBe("theme");
    // Draft products and Shopify-generated collections are not audited.
    expect(JSON.stringify(findingsOf(imp))).not.toMatch(/secret-draft|collections\/all/);
    // Green Tea's SEO data is fine; only its catalog data (no photos, short description) is flagged.
    const greenTea = findingsOf(imp).filter((f) => f.affectedUrls.some((u) => u.includes("green-tea"))).map((f) => f.auditId);
    expect(greenTea.sort()).toEqual(["catalog.product.no-images", "catalog.product.thin-description"]);

    const report = JSON.parse(imp.reportJson);
    expect(report).toMatchObject({ origin: "in-app", scan: { products: 2, collections: 2 }, theme: { status: "checked", themeName: "Dawn" }, storefront: { status: "not_checked", message: expect.stringMatching(/password protected/) } });
    expect(writes()).toHaveLength(0);
  });

  it("checks storefront HTML only on the shop's own domain", async () => {
    const html = `<html><head><title>Shop</title><script src="https://cdn.tracker.example/a.js"></script></head><body><h1>A</h1><h1>B</h1><img src="/x.jpg"></body></html>`;
    const fetchPage = vi.fn(async () => ({ status: 200, headers: {}, text: html }));
    const imp = await createInAppAudit({ ...base, fetchPage });
    for (const [url, opts] of fetchPage.mock.calls) {
      expect(new URL(url).hostname).toBe(HOST);
      expect(opts.allowedHosts).toEqual([HOST, fake.session.shop]);
      expect(opts.maxRedirects).toBe(0);
    }
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(6);
    const ids = findingsOf(imp).map((f) => f.auditId);
    expect(ids).toEqual(expect.arrayContaining(["seo.h1.multiple", "seo.img.alt-missing", "seo.og.missing", "seo.structured-data.missing", "code.render-blocking"]));
    // Storefront and theme evidence for the same issue become one finding.
    expect(findingsOf(imp).find((f) => f.auditId === "seo.lang.missing").origin).toBe("storefront+theme");
  });

  it("parses page HTML conservatively", () => {
    const a = analyzeHtml(
      '<html lang="en"><head><title>T</title><link rel="canonical" href="/"><meta property="og:title" content="x"><script src="/a.js" defer></script><script type="application/ld+json">{}</script></head><body><h1>x</h1><img alt="" src="a"><img src="http://x/b"></body></html>',
      HOST,
    );
    expect(a).toMatchObject({ hasTitle: true, h1: 1, imgsWithoutAlt: 1, hasOg: true, hasJsonLd: true, hasLang: true, hasCanonical: true, blockingScripts: 0, insecure: 1 });
  });

  it("refuses to start a second audit within a minute", async () => {
    await createInAppAudit({ ...base, fetchPage: passwordProtected });
    await expect(createInAppAudit({ ...base, fetchPage: passwordProtected })).rejects.toMatchObject({ code: "AUDIT_TOO_SOON" });
  });

  it("treats Admin-detected missing alt text as a confirmed, fixable cause", async () => {
    const imp = await createInAppAudit({ ...base, fetchPage: passwordProtected });
    const alt = findingsOf(imp).find((f) => f.auditId === "admin.media.alt-missing");
    expect(classifyFinding(alt)).toMatchObject({ status: "auto", actionClass: "admin_api" });
  });
});

describe("theme chosen once per audit", () => {
  it("stores the chosen theme and uses it for every theme fix", async () => {
    const imp = await createInAppAudit({ ...base, fetchPage: passwordProtected, themeId: draftTheme.id });
    expect(imp.themeId).toBe(draftTheme.id);
    const r = await prepareFinding({ ...base, importId: imp.id, findingKey: "seo.lang.missing" });
    expect(r.created).toBe(1);
    const plan = await db.fixExecution.findFirst({ where: { importId: imp.id, fixType: "theme_html_lang" } });
    expect(plan.resourceId).toBe(draftTheme.id);
  });

  it("asks for the theme instead of guessing, and never accepts the live theme", async () => {
    const imp = await createInAppAudit({ ...base, fetchPage: passwordProtected });
    await expect(prepareFinding({ ...base, importId: imp.id, findingKey: "seo.lang.missing" })).rejects.toMatchObject({ code: "THEME_REQUIRED" });
    await expect(setImportTheme({ ...base, importId: imp.id, themeId: liveTheme.id })).rejects.toMatchObject({ code: "LIVE_THEME" });
    await expect(setImportTheme({ ...base, importId: imp.id, themeId: "gid://shopify/OnlineStoreTheme/999999" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createInAppAudit({ ...base, fetchPage: passwordProtected, themeId: liveTheme.id })).rejects.toMatchObject({ code: "LIVE_THEME" });
    const theme = await setImportTheme({ ...base, importId: imp.id, themeId: draftTheme.id });
    expect(theme.name).toBe("Dawn copy");
    expect((await prepareFinding({ ...base, importId: imp.id, findingKey: "seo.lang.missing" })).created).toBe(1);
  });
});

describe("prepare all fixable issues", () => {
  it("prepares every fixable finding as a proposal; nothing runs until approved", async () => {
    const imp = await createInAppAudit({ ...base, fetchPage: passwordProtected });
    const r = await prepareAllFixable({ ...base, importId: imp.id });
    // Theme fixes wait for a theme choice; Admin fixes do not need one.
    expect(r.skipped.map((s) => s.key)).toEqual(expect.arrayContaining(["seo.lang.missing", "seo.canonical.missing"]));
    const plans = await db.fixExecution.findMany({ where: { importId: imp.id } });
    expect(plans.map((p) => p.fixType).sort()).toEqual(
      ["collection_seo_description", "collection_seo_title", "product_image_alt", "product_image_alt", "product_seo_description", "product_seo_title"].sort(),
    );
    expect(plans.every((p) => p.status === EXEC.NEEDS_REVIEW)).toBe(true);
    expect(writes()).toHaveLength(0);

    // The normal approve -> execute -> verify path still applies.
    const alt = plans.find((p) => p.fixType === "product_image_alt");
    const before = JSON.parse(alt.beforeJson).alt;
    await approvePlans({ ...base, importId: imp.id, items: [{ planId: alt.id, seenRevision: alt.revision, value: "Blue cotton shirt, front view", seenBefore: before }] });
    const { results } = await executePlans({ ...base, importId: imp.id, planIds: [alt.id], sleep: async () => {} });
    expect(results[0]).toMatchObject({ ok: true, verificationStatus: VERIFY.PASSED });
    expect(shirt.media.find((m) => m.id === alt.resourceId).alt).toBe("Blue cotton shirt, front view");
  });

  it("includes theme fixes once a theme is chosen", async () => {
    const imp = await createInAppAudit({ ...base, fetchPage: passwordProtected, themeId: draftTheme.id });
    const r = await prepareAllFixable({ ...base, importId: imp.id });
    expect(r.skipped).toEqual([]);
    const types = (await db.fixExecution.findMany({ where: { importId: imp.id } })).map((p) => p.fixType);
    expect(types).toEqual(expect.arrayContaining(["theme_html_lang", "theme_canonical_tag"]));
    expect(liveTheme.files["layout/theme.liquid"]).toBe(LAYOUT);
    expect(draftTheme.files["layout/theme.liquid"]).toBe(LAYOUT); // prepared, not written
  });
});
