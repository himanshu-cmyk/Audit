/* eslint-env node */
// Server-renders each new page with realistic loader data to catch runtime
// rendering errors. Loader data is produced by the real service against the
// fake Admin API, then passed through a static router.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";

const mocks = vi.hoisted(() => ({ ctx: null }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => mocks.ctx },
}));
vi.mock("../app/db.server", () => ({
  default: new Proxy({}, { get: (_t, prop) => mocks.ctx.db[prop] }),
}));

const { createImport, prepareFinding, approvePlans, executePlans } = await import("../app/fixes/service.server");
const { auditJson, finding } = await import("./helpers/auditBuilders");
const { createFakeShop } = await import("./helpers/fakeShopify");
const { createTestDb } = await import("./helpers/testDb");

let testDb;
let importId;
beforeAll(async () => {
  testDb = await createTestDb();
  const fake = createFakeShop({ shop: "ui.myshopify.com", primaryHost: "www.example-store.com" });
  fake.api.addProduct({ title: "Blue Shirt", handle: "blue-shirt", description: "", images: [{ alt: "" }] });
  fake.api.addTheme({ name: "Draft", role: "UNPUBLISHED", files: { "layout/theme.liquid": "<html><head></head></html>" } });
  mocks.ctx = { db: testDb.db, admin: fake.admin, session: fake.session, redirect: vi.fn() };
  const base = { db: testDb.db, admin: fake.admin, session: fake.session };
  const url = "https://www.example-store.com/products/blue-shirt";
  const imp = await createImport({
    ...base,
    text: auditJson({
      findings: [
        finding("seo.meta-description.missing", "seo", [url]),
        finding("seo.img.alt-missing", "seo", [url]),
        finding("seo.lang.missing", "seo", []),
        finding("shopify.app-bloat", "shopify", [url], { evidence: "<script>alert(1)</script>" }),
      ],
    }),
  });
  importId = imp.id;
  await prepareFinding({ ...base, importId, findingKey: "seo.meta-description.missing" });
  await prepareFinding({ ...base, importId, findingKey: "seo.img.alt-missing", acknowledgeUnconfirmed: true });
  const plans = await testDb.db.fixExecution.findMany({ where: { importId } });
  const desc = plans.find((p) => p.fixType === "product_seo_description");
  await approvePlans({ ...base, importId, items: [{ planId: desc.id, seenRevision: desc.revision, value: "A blue cotton shirt, machine washable, in five sizes.", seenBefore: null }] });
  await executePlans({ ...base, importId, planIds: [desc.id], sleep: async () => {} });
  // An AI suggestion for the remaining alt-text change, as stored by the AI service.
  const alt = plans.find((p) => p.fixType === "product_image_alt");
  await testDb.db.aiSuggestion.create({
    data: {
      shop: fake.session.shop, importId, findingKey: alt.findingKey, executionId: alt.id, kind: "value",
      provider: "gemini", model: "gemini-test", promptVersion: "t", status: "VALID",
      outputJson: JSON.stringify({ findingId: alt.findingKey, category: "seo", evidenceRefs: ["S1", "S3"], likelyRootCause: "No alt text set.", confidence: 0.7, uncertainties: ["Theme images may also lack alt"], recommendedAction: "Add alt text", proposedValue: "Blue cotton shirt", patchCandidate: null, requiredResourceType: "MediaImage", validationRequirements: [], risk: "low", automationSuggested: true, manualReviewReason: null }),
    },
  });
});
afterAll(async () => testDb.cleanup());

async function render(mod, path, routePath) {
  const routes = [{ id: "page", path: routePath, loader: mod.loader, Component: mod.default }];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`https://app.example.com${path}`));
  if (context instanceof Response) throw new Error(`loader returned a Response (${context.status})`);
  if (context.errors) throw Object.values(context.errors)[0];
  return renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
}

describe("pages render with real data", () => {
  it("audit results", async () => {
    const html = await render(await import("../app/routes/app.audits._index.jsx"), "/app/audits", "/app/audits");
    expect(html).toContain("example-store.com");
    expect(html).toContain("Store matched");
    expect(html).toContain("Run audit now");
    expect(html).toContain("Storefront password (only if your store is password protected)");
    expect(html).toContain('type="password"');
    expect(html).toContain("Theme to apply theme fixes to");
    expect(html).toContain("Import a report file (optional)");
  });

  it("fix dashboard escapes untrusted evidence", async () => {
    const html = await render(await import("../app/routes/app.audits.$importId.jsx"), `/app/audits/${importId}`, "/app/audits/:importId");
    expect(html).toContain("Findings by severity");
    expect(html).toContain("Shopify Theme");
    expect(html).toContain("Requires Manual Review");
    expect(html).toContain("AI suggestions are off"); // no GEMINI_API_KEY in tests: everything else still works
    expect(html).toContain("Shopify Admin data (live)");
    expect(html).toContain("Source, integrity and limitations");
    // The theme is asked once at the top, never per finding.
    expect(html.match(/Which theme should theme fixes go to?/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Theme to patch"');
    expect(html).toContain("Choose the theme to fix at the top of this page first.");
    expect(html).toContain("Prepare all fixable issues");
    expect(html).toContain("Admin API fix (after resource check and approval)");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("review screen shows before and proposed values", async () => {
    const html = await render(await import("../app/routes/app.audits.$importId_.review.jsx"), `/app/audits/${importId}/review`, "/app/audits/:importId/review");
    expect(html).toContain("Review proposed changes");
    expect(html).toContain("AI recommendation (gemini-test), advisory only");
    expect(html).toContain("Uncertainties: ");
    expect(html).toContain("based on evidence S1, S3");
    expect(html).toContain("Use this suggestion");
    expect(html).toContain("Reject fix");
    expect(html).toContain("Mark for manual review");
    expect(html).toContain("Awaiting Approval");
    expect(html).toContain("Completed");
    expect(html).toContain("Proposed <!-- -->Alt text");
    expect(html).toContain("Verification Passed");
    expect(html).toContain("takes effect on your live storefront immediately");
  });

  it("execution history", async () => {
    const html = await render(await import("../app/routes/app.history.jsx"), "/app/history", "/app/history");
    expect(html).toContain("A blue cotton shirt, machine washable, in five sizes.");
    expect(html).toContain("Check storefront");
    expect(html).toContain("Not automatically reversible");
  });
});
