/* eslint-env node */
// Catalog quality, theme files, store setup, and pages / blogs / menus checks of
// the in-app audit. Shopify is the in-memory fake; storefront checks are off.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInAppAudit, findingsOf, prepareFinding } from "../app/fixes/service.server";
import { createFakeShop } from "./helpers/fakeShopify";
import { createTestDb } from "./helpers/testDb";

const HOST = "shop-coverage.myshopify.com";
const LONG = "A plain cotton shirt with long sleeves, cut for a relaxed everyday fit. It is machine washable at forty degrees, comes in five sizes, and is made from organic cotton grown without pesticides. Pairs with jeans or chinos.";
const LAYOUT = '<html lang="en"><head>{% render \'meta-tags\' %}<link rel="canonical" href="{{ canonical_url }}"></head><body></body></html>';

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
let n = 0;
beforeEach(() => {
  fake = createFakeShop({ shop: HOST, primaryHost: HOST });
  base = { db, admin: fake.admin, session: { ...fake.session, shop: `cov-${n++}-${Math.random().toString(36).slice(2, 6)}.myshopify.com` } };
  live = fake.api.addTheme({
    name: "Horizon",
    role: "MAIN",
    files: {
      "layout/theme.liquid": LAYOUT,
      "snippets/meta-tags.liquid": '<meta property="og:title" content="{{ page_title }}">',
      "config/settings_data.json": JSON.stringify({ current: { favicon: "shopify://shop_images/f.png" } }),
      "templates/product.json": JSON.stringify({ sections: { main: { type: "main-product" } }, order: ["main"] }),
      "sections/main-product.liquid": "<h1>{{ product.title }}</h1>{% render 'product-schema' %}",
      "snippets/product-schema.liquid": "<script type=\"application/ld+json\">{{ product | structured_data }}</script>",
    },
  });
});

const audit = (extra = {}) => createInAppAudit({ ...base, includeStorefront: false, ...extra });
const ids = (imp) => findingsOf(imp).map((f) => f.auditId);
const evidence = (imp, id) => findingsOf(imp).find((f) => f.auditId === id)?.evidence ?? "";

describe("A. product and collection quality", () => {
  it("flags missing images, thin descriptions, zero prices and duplicates", async () => {
    fake.api.addProduct({ title: "Blue Shirt", handle: "blue-shirt", description: LONG, seoTitle: "Cotton Shirt | Example Store", images: [{ alt: "Blue shirt front" }] });
    fake.api.addProduct({ title: "Red Shirt", handle: "red-shirt", description: LONG, seoTitle: "Cotton Shirt | Example Store", images: [{ alt: "Red shirt front" }] });
    const freebie = fake.api.addProduct({ title: "Sample Pack", handle: "sample-pack", description: "Free sample.", images: [] });
    freebie.price = "0.00";
    const imp = await audit();
    expect(evidence(imp, "catalog.product.no-images")).toBe('Product "Sample Pack" has no images');
    expect(evidence(imp, "catalog.product.thin-description")).toMatch(/Sample Pack": 2 word/);
    expect(evidence(imp, "catalog.product.zero-price")).toMatch(/Sample Pack/);
    expect(findingsOf(imp).find((f) => f.auditId === "seo.title.duplicate").affectedUrls.sort()).toEqual([`https://${HOST}/products/blue-shirt`, `https://${HOST}/products/red-shirt`]);
    // Long, unique, photographed products are not flagged.
    expect(evidence(imp, "catalog.product.thin-description")).not.toMatch(/Blue Shirt/);
  });

  it("flags empty collections and collection images without alt text", async () => {
    fake.api.addCollection({ title: "Winter", handle: "winter", description: LONG, seoTitle: "Winter clothing collection", productsCount: 0, image: { altText: "" } });
    const imp = await audit();
    expect(evidence(imp, "catalog.collection.empty")).toMatch(/Winter/);
    expect(evidence(imp, "admin.collection-image.alt-missing")).toMatch(/Winter/);
    // Shown under its own dashboard group, and never auto-fixed.
    expect(findingsOf(imp).find((f) => f.auditId === "catalog.collection.empty").displayCategory).toBe("catalog");
    await expect(prepareFinding({ ...base, importId: imp.id, findingKey: "catalog.collection.empty" })).rejects.toMatchObject({ code: "UNSUPPORTED_FIX_TYPE" });
  });
});

describe("B. theme files", () => {
  it("finds Open Graph and product structured data through snippets and JSON templates", async () => {
    const imp = await audit();
    expect(ids(imp)).not.toContain("seo.og.missing");
    expect(ids(imp)).not.toContain("seo.structured-data.missing");
  });

  it("flags them when the theme does not output them", async () => {
    live.files["snippets/meta-tags.liquid"] = "<meta name=\"description\" content=\"x\">";
    live.files["snippets/product-schema.liquid"] = "<div></div>";
    const imp = await audit();
    expect(evidence(imp, "seo.og.missing")).toMatch(/Horizon/);
    expect(evidence(imp, "seo.structured-data.missing")).toMatch(/product template/);
  });

  it("does not guess when the product template cannot be read", async () => {
    delete live.files["templates/product.json"];
    const imp = await audit();
    expect(ids(imp)).not.toContain("seo.structured-data.missing");
    expect(JSON.parse(imp.reportJson).theme.notes.join()).toMatch(/structured data not checked/);
  });

  it("flags many leftover unpublished themes", async () => {
    for (let i = 0; i < 5; i++) fake.api.addTheme({ name: `Copy ${i}`, role: "UNPUBLISHED", files: {} });
    expect(evidence(await audit(), "shopify.themes.unused")).toMatch(/5 unpublished themes/);
  });
});

describe("C. store setup", () => {
  it("flags password protection and the default myshopify domain", async () => {
    fake.state.passwordProtected = true;
    const imp = await audit();
    expect(ids(imp)).toEqual(expect.arrayContaining(["shopify.store.password-protected", "trust.domain.custom-missing"]));
  });

  it("does not flag a store with its own domain", async () => {
    const own = createFakeShop({ shop: HOST, primaryHost: "www.example-store.com" });
    own.api.addTheme({ name: "Horizon", role: "MAIN", files: live.files });
    const imp = await createInAppAudit({ db, admin: own.admin, session: { ...own.session, shop: "own-domain.myshopify.com" }, includeStorefront: false });
    expect(ids(imp)).not.toContain("trust.domain.custom-missing");
  });
});

describe("D. pages, blog posts and menus", () => {
  it("checks page and article SEO and the contact page", async () => {
    fake.state.pages = [
      { id: "gid://shopify/Page/1", handle: "about", title: "About", isPublished: true, bodySummary: "", titleTag: null, descriptionTag: null },
      { id: "gid://shopify/Page/2", handle: "draft-page", title: "Draft", isPublished: false, bodySummary: "", titleTag: null, descriptionTag: null },
    ];
    fake.state.articles = [{ id: "gid://shopify/Article/1", handle: "hello", title: "Hello world from our store", isPublished: true, summary: "", blog: { handle: "news" }, titleTag: null, descriptionTag: { value: "x".repeat(120) } }];
    const imp = await audit();
    const missing = findingsOf(imp).find((f) => f.auditId === "seo.meta-description.missing");
    expect(missing.affectedUrls).toEqual([`https://${HOST}/pages/about`]);
    expect(evidence(imp, "seo.title.length")).toMatch(/Page "About"/);
    expect(ids(imp)).toContain("trust.contact.missing");
    expect(JSON.stringify(findingsOf(imp))).not.toMatch(/draft-page|blogs\/news\/hello/);
    // Page SEO is fixed manually: the app has no write permission for pages.
    const r = await prepareFinding({ ...base, importId: imp.id, findingKey: "seo.meta-description.missing" });
    expect(r.created).toBe(0);
    expect(r.manual[0].reason).toMatch(/write_online_store_pages/);
  });

  it("finds menu links to deleted products, collections and pages", async () => {
    fake.api.addProduct({ title: "Blue Shirt", handle: "blue-shirt", description: LONG, images: [{ alt: "Front" }] });
    fake.state.pages = [{ id: "gid://shopify/Page/3", handle: "contact", title: "Contact us today", isPublished: true, bodySummary: LONG, titleTag: null, descriptionTag: null }];
    fake.state.menus = [
      {
        handle: "main-menu",
        title: "Main menu",
        items: [
          { title: "Shirt", type: "PRODUCT", url: "/products/blue-shirt", resourceId: "gid://shopify/Product/1", items: [] },
          { title: "Old product", type: "PRODUCT", url: "/products/gone", resourceId: null, items: [] },
          { title: "Typed link", type: "HTTP", url: "/products/never-existed", resourceId: null, items: [{ title: "Old page", type: "HTTP", url: "/pages/old", resourceId: null, items: [] }] },
          { title: "Contact", type: "HTTP", url: "/pages/contact", resourceId: null, items: [] },
          { title: "Blog", type: "HTTP", url: "https://elsewhere.example/blog", resourceId: null, items: [] },
        ],
      },
    ];
    const imp = await audit();
    expect(evidence(imp, "links.menu-broken").split("\n")).toEqual([
      'Menu "Main menu": "Old product" → /products/gone',
      'Menu "Main menu": "Typed link" → /products/never-existed',
      'Menu "Main menu": "Old page" → /pages/old',
    ]);
    expect(ids(imp)).not.toContain("trust.contact.missing");
  });

  it("explains what was skipped without the new permissions", async () => {
    fake.state.grantedScopes = ["write_products", "read_themes"];
    const imp = await audit();
    const coverage = JSON.parse(imp.reportJson).coverage.map((c) => c.reason).join("\n");
    expect(coverage).toMatch(/read_online_store_pages and read_content/);
    expect(coverage).toMatch(/read_online_store_navigation/);
    expect(fake.state.calls.some((c) => ["StoreAuditScanPages", "StoreAuditMenus"].includes(c.name))).toBe(false);
  });
});
