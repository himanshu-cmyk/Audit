/* eslint-env node */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EXEC } from "../app/fixes/constants";
import { extractHeadSeo, liveCheckPlan } from "../app/fixes/liveCheck.server";
import { approvePlans, createImport, executePlans, prepareFinding } from "../app/fixes/service.server";
import { auditJson, finding } from "./helpers/auditBuilders";
import { createFakeShop } from "./helpers/fakeShopify";
import { createTestDb } from "./helpers/testDb";

let testDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => testDb.cleanup());

const VALUE = "Cold pressed karela and jamun juice in a 500 ml bottle with no added sugar.";

async function appliedPlan() {
  const db = testDb.db;
  const fake = createFakeShop({ shop: "live-check.myshopify.com", primaryHost: "www.example-store.com" });
  fake.api.addProduct({ title: "Karela Jamun Juice", handle: "karela-jamun-juice", description: "" });
  const base = { db, admin: fake.admin, session: fake.session };
  const imp = await createImport({ ...base, text: auditJson({ findings: [finding("seo.meta-description.missing", "seo", ["https://www.example-store.com/products/karela-jamun-juice"])] }) });
  await prepareFinding({ ...base, importId: imp.id, findingKey: "seo.meta-description.missing" });
  const [plan] = await db.fixExecution.findMany({ where: { importId: imp.id } });
  await approvePlans({ ...base, importId: imp.id, items: [{ planId: plan.id, value: VALUE, seenBefore: null }] });
  await executePlans({ ...base, importId: imp.id, planIds: [plan.id], sleep: async () => {} });
  expect((await db.fixExecution.findUnique({ where: { id: plan.id } })).status).toBe(EXEC.APPLIED);
  return { base, plan };
}

describe("storefront re-check", () => {
  it("parses title and meta description from the page head", () => {
    expect(extractHeadSeo('<head><title> A &amp; B </title><meta content="Desc &quot;x&quot;" name="description"></head>')).toEqual({ title: "A & B", description: 'Desc "x"' });
  });

  it("fetches only the shop's own domain and reports a reflected change", async () => {
    const { base, plan } = await appliedPlan();
    const fetchImpl = vi.fn(async () => new Response(`<html><head><title>Karela Jamun Juice – Example</title><meta name="description" content="${VALUE}"></head></html>`, { status: 200 }));
    const r = await liveCheckPlan({ ...base, planId: plan.id, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://www.example-store.com/products/karela-jamun-juice");
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("manual");
    expect(r.status).toBe("REFLECTED");
    expect(r.detectorPasses).toBe(true);
  });

  it("reports password-protected storefronts as unavailable instead of passing", async () => {
    const { base, plan } = await appliedPlan();
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://www.example-store.com/password" } });
    const r = await liveCheckPlan({ ...base, planId: plan.id, fetchImpl });
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.message).toMatch(/password protected/);
  });
});
