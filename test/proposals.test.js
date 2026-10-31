/* eslint-env node */
// From finding to reviewable proposal: grouped findings become one change per
// resource, failures stay per resource, AI drafts use bounded store facts, and
// merchant-only or rendered-page findings never enter the execution pipeline.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiAssistImport, suggestForPlan } from "../app/ai/suggest.server";
import { parsePagespeed } from "../app/audit/pagespeed.server";
import { EXEC, startingProposal } from "../app/fixes/constants";
import { classifyFinding, eligibilityProblems, getFixType, manualReason } from "../app/fixes/registry.server";
import { approvePlans, createImport, executePlans, prepareAllFixable, prepareFinding, prepareSummary } from "../app/fixes/service.server";
import { auditJson, finding } from "./helpers/auditBuilders";
import { createFakeShop } from "./helpers/fakeShopify";
import { createTestDb } from "./helpers/testDb";

const HOST = "www.example-store.com";
const col = (h) => `https://${HOST}/collections/${h}`;

let testDb;
let db;
beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
});
afterAll(async () => testDb.cleanup());

let fake;
let base;
let juice;
let tea;
beforeEach(() => {
  fake = createFakeShop({ shop: `prop-${Math.random().toString(36).slice(2, 8)}.myshopify.com`, primaryHost: HOST });
  base = { db, admin: fake.admin, session: fake.session };
  juice = fake.api.addProduct({ title: "Karela Jamun Juice", handle: "karela-jamun-juice", description: "Cold pressed karela and jamun juice in a 500 ml glass bottle." });
  tea = fake.api.addProduct({ title: "Tulsi Green Tea", handle: "tulsi-green-tea", description: "Loose leaf green tea blended with organic tulsi leaves." });
});

function fakeProvider(answer) {
  return { name: "fake", model: "fake-model-1", generateJson: vi.fn(async (args) => (typeof answer === "function" ? answer(args) : answer)) };
}

// Answers like a careful model: builds the value only from the evidence sent.
function evidenceAnswer({ prompt }) {
    const data = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1));
    const ev = Object.fromEntries(data.evidence.map((e) => [e.id, e.text]));
    const products = (ev.S8 || "").split("\n").map((l) => l.split(" – ")[0]).filter(Boolean);
    return {
      findingId: data.findingId,
      category: data.category,
      evidenceRefs: ["S1", ...(ev.S8 ? ["S8"] : [])],
      likelyRootCause: "No SEO description is set and the collection has no description text.",
      confidence: 0.7,
      uncertainties: [],
      recommendedAction: "Set an SEO description that names what the collection contains.",
      proposedValue: `Shop ${ev.S1}: ${products.join(" and ")}. Browse the full range at ${ev.S9}.`.slice(0, 160),
      patchCandidate: null,
      requiredResourceType: data.resourceType,
      validationRequirements: ["Check the search engine listing preview."],
      risk: "low",
      automationSuggested: true,
      manualReviewReason: null,
    };
}
const evidenceProvider = () => fakeProvider(evidenceAnswer);

async function importWith(findings) {
  return createImport({ ...base, text: auditJson({ findings }) });
}

const plansOf = (imp) => db.fixExecution.findMany({ where: { importId: imp.id }, orderBy: { createdAt: "asc" } });

describe("grouped findings", () => {
  it("prepares one independent change per resource and reports the rest separately", async () => {
    fake.api.addCollection({ title: "Juices", handle: "juices", products: [juice] });
    fake.api.addCollection({ title: "Teas", handle: "teas", products: [tea] });
    fake.api.addCollection({ title: "Home page", handle: "frontpage", products: [juice, tea] });
    const urls = [col("juices"), col("teas"), col("frontpage"), col("gone"), `https://${HOST}/pages/about`];
    const imp = await importWith([finding("seo.meta-description.missing", "seo", urls)]);
    const r = await prepareFinding({ ...base, importId: imp.id, findingKey: "seo.meta-description.missing" });

    expect(r).toMatchObject({ affected: 5, prepared: 3, created: 3, failed: [] });
    expect(r.unresolved.map((u) => u.url)).toEqual([col("gone")]);
    expect(r.manual.map((m) => m.url)).toEqual([`https://${HOST}/pages/about`]);
    expect(prepareSummary(r)).toBe("5 affected pages · 3 changes prepared · 1 need manual review · 1 not found in the store");
    const plans = await plansOf(imp);
    expect(new Set(plans.map((p) => p.resourceId)).size).toBe(3);
    expect(plans.every((p) => p.resourceType === "Collection" && p.status === EXEC.NEEDS_REVIEW)).toBe(true);
    // The store had no text to start from: the proposal is empty, not invented.
    expect(plans.map((p) => JSON.parse(p.proposedJson).value)).toEqual(["", "", ""]);

    // Preparing again refreshes the same changes instead of adding duplicates.
    const again = await prepareFinding({ ...base, importId: imp.id, findingKey: "seo.meta-description.missing" });
    expect(again).toMatchObject({ created: 0, updated: 3 });
    expect(await plansOf(imp)).toHaveLength(3);
  });

  it("keeps preparing other resources when one of them fails", async () => {
    const a = fake.api.addCollection({ title: "Juices", handle: "juices" });
    fake.api.addCollection({ title: "Teas", handle: "teas" });
    fake.state.interceptors.StoreAuditCollectionSeo = ({ id }) =>
      id === a.id ? new Response(JSON.stringify({ errors: [{ message: "Internal error" }] })) : undefined;
    const imp = await importWith([finding("seo.meta-description.missing", "seo", [col("juices"), col("teas")])]);
    const r = await prepareFinding({ ...base, importId: imp.id, findingKey: "seo.meta-description.missing" });
    expect(r.prepared).toBe(1);
    expect(r.failed).toEqual([{ url: col("juices"), reason: expect.stringMatching(/^Collection SEO description could not be prepared/) }]);
    expect((await plansOf(imp)).map((p) => p.resourceLabel)).toEqual(["Teas"]);
  });

  it("still stops on an expired session instead of reporting it per resource", async () => {
    fake.api.addCollection({ title: "Juices", handle: "juices" });
    fake.state.interceptors.StoreAuditCollectionSeo = () => {
      throw new Response(null, { status: 401 });
    };
    const imp = await importWith([finding("seo.meta-description.missing", "seo", [col("juices")])]);
    await expect(prepareFinding({ ...base, importId: imp.id, findingKey: "seo.meta-description.missing" })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });
});

describe("AI drafts from verified store data", () => {
  async function emptyCollections() {
    fake.api.addCollection({ title: "Juices", handle: "juices", products: [juice] });
    fake.api.addCollection({ title: "Teas", handle: "teas", products: [tea] });
    const imp = await importWith([finding("seo.meta-description.missing", "seo", [col("juices"), col("teas")])]);
    await prepareFinding({ ...base, importId: imp.id, findingKey: "seo.meta-description.missing" });
    return { imp, plans: await plansOf(imp) };
  }

  it("drafts a missing collection description from the products it contains", async () => {
    const { plans } = await emptyCollections();
    const provider = evidenceProvider();
    const s = await suggestForPlan({ ...base, planId: plans[0].id, provider, env: {} });
    const { prompt } = provider.generateJson.mock.calls[0][0];
    expect(prompt).toMatch(/Products in this collection \(first 1 of 1\)/);
    expect(prompt).toContain("Karela Jamun Juice");
    expect(prompt).toMatch(/An empty current value is not a reason to give up/);
    // Only catalog facts: no ids, domains or prices are sent.
    expect(prompt).not.toMatch(/gid:\/\/|myshopify\.com|price/i);
    expect(s.status).toBe("VALID");
    expect(s.output.proposedValue).toBe("Shop Juices: Karela Jamun Juice. Browse the full range at Example Store.");
    expect(s.output.evidenceRefs).toEqual(["S1", "S8"]);
  });

  it("gives each resource its own value, and the editor starts from it", async () => {
    const { imp, plans } = await emptyCollections();
    const r = await aiAssistImport({ ...base, importId: imp.id, provider: evidenceProvider(), env: {}, explain: false });
    expect(r.values).toBe(2);
    const rows = await db.aiSuggestion.findMany({ where: { importId: imp.id, kind: "value" } });
    const values = rows.map((x) => JSON.parse(x.outputJson).proposedValue);
    expect(new Set(values).size).toBe(2);
    expect(values.join(" ")).toMatch(/Tulsi Green Tea/);

    const plan = { id: plans[0].id, proposed: { value: "" } };
    const row = rows.find((x) => x.executionId === plans[0].id);
    const suggestion = { id: row.id, status: "VALID", executionId: row.executionId, output: JSON.parse(row.outputJson) };
    expect(startingProposal(plan, suggestion)).toEqual({ value: suggestion.output.proposedValue, aiSuggestionId: row.id });
    // A store-data value wins; invalid or foreign suggestions are never used.
    expect(startingProposal({ ...plan, proposed: { value: "Store text" } }, suggestion).value).toBe("Store text");
    expect(startingProposal(plan, { ...suggestion, status: "INVALID" }).value).toBe("");
    expect(startingProposal(plan, { ...suggestion, executionId: "other" }).value).toBe("");
  });

  it("an approved AI draft goes through the normal approval, execution and verification", async () => {
    const { imp, plans } = await emptyCollections();
    const s = await suggestForPlan({ ...base, planId: plans[0].id, provider: evidenceProvider(), env: {} });
    const plan = await db.fixExecution.findUnique({ where: { id: plans[0].id } });
    const [ok] = await approvePlans({
      ...base,
      importId: imp.id,
      items: [{ planId: plan.id, seenRevision: plan.revision, value: s.output.proposedValue, seenBefore: null, aiSuggestionId: s.id }],
    });
    expect(ok).toMatchObject({ ok: true });
    const approved = await db.fixExecution.findUnique({ where: { id: plan.id } });
    expect(JSON.parse(approved.approvedJson).source).toMatchObject({ type: "ai", suggestionId: s.id });
    const { results } = await executePlans({ ...base, importId: imp.id, planIds: [plan.id] });
    expect(results[0]).toMatchObject({ ok: true, verificationStatus: "PASSED" });
  });

  it("rejects drafts with claims, links, HTML or Liquid that the store data does not support", async () => {
    const { plans } = await emptyCollections();
    const cases = [
      ["Certified organic juices that cure fatigue.", /claims not found in your store's data: organic, certified, cure\./],
      ["Juices at https://evil.example now for the family.", /must not contain links/],
      ["<b>Juices</b> for you and your whole family.", /cannot contain HTML/],
      ["Juices {{ shop.name }} for you and your family.", /cannot contain Liquid/],
    ];
    for (const [bad, reason] of cases) {
      const provider = fakeProvider((args) => ({ ...evidenceAnswer(args), proposedValue: bad }));
      const s = await suggestForPlan({ ...base, planId: plans[0].id, provider, env: { AI_MAX_REQUESTS_PER_MINUTE: "20" } });
      expect(s.status, bad).toBe("INVALID");
      expect(s.errors.join(" "), bad).toMatch(reason);
    }
    // A claim the collection's own products make is allowed.
    const ok = fakeProvider((args) => ({ ...evidenceAnswer(args), proposedValue: "Green tea with organic tulsi leaves, loose leaf." }));
    const good = await suggestForPlan({ ...base, planId: plans[1].id, provider: ok, env: { AI_MAX_REQUESTS_PER_MINUTE: "20" } });
    expect(good.status, good.errors.join(" ")).toBe("VALID");
  });

  it("an AI failure for one change does not stop the others", async () => {
    const { imp } = await emptyCollections();
    let n = 0;
    const flaky = fakeProvider(async (args) => {
      if (n++ === 0) {
        const { aiError } = await import("../app/ai/errors.server");
        throw aiError("AI_TIMEOUT");
      }
      return evidenceAnswer(args);
    });
    const r = await aiAssistImport({ ...base, importId: imp.id, provider: flaky, env: {}, explain: false });
    expect(r).toMatchObject({ values: 1, failed: 1 });
  });

  it("drafts only the requested finding's changes", async () => {
    const { imp } = await emptyCollections();
    const provider = evidenceProvider();
    const r = await aiAssistImport({ ...base, importId: imp.id, provider, env: {}, explain: false, findingKey: "seo.title.length" });
    expect(r.values).toBe(0);
    expect(provider.generateJson).not.toHaveBeenCalled();
  });
});

describe("findings that never become executable changes", () => {
  it("keeps legal policies merchant-managed", async () => {
    const imp = await importWith([finding("trust.policies.missing", "trust", [])]);
    const f = { auditId: "trust.policies.missing", key: "trust.policies.missing", affectedUrls: [] };
    expect(classifyFinding(f)).toMatchObject({ status: "manual", outcome: "merchant_action" });
    expect(manualReason(f)).toMatch(/Settings > Policies/);
    expect(manualReason(f)).toMatch(/never drafts, publishes or changes them/);
    await expect(prepareFinding({ ...base, importId: imp.id, findingKey: "trust.policies.missing" })).rejects.toMatchObject({ code: "UNSUPPORTED_FIX_TYPE" });
    const r = await prepareAllFixable({ ...base, importId: imp.id });
    expect(r.prepared).toBe(0);
    expect(await plansOf(imp)).toHaveLength(0);
  });

  it("explains rendered-page findings as needing their source, not as fixed", () => {
    for (const id of ["a11y.link-name", "a11y.duplicate-id", "a11y.color-contrast", "seo.h1.multiple", "perf.cwv.lcp", "code.console-errors"]) {
      const f = { auditId: id, key: id, title: id, affectedUrls: [`https://${HOST}/`] };
      expect(classifyFinding(f).outcome, id).toBe("more_evidence");
      expect(manualReason(f), id).toMatch(/theme|script/);
    }
    expect(classifyFinding({ auditId: "catalog.collection.empty", key: "x", affectedUrls: [] }).outcome).toBe("merchant_action");
    expect(classifyFinding({ auditId: "seo.meta-description.missing", key: "x", affectedUrls: [col("a")] }).outcome).toBe("change");
  });

  it("keeps theme patches preview-only while theme writes are disabled", () => {
    const problems = eligibilityProblems(getFixType("theme_html_lang"), {
      session: fake.session,
      importRecord: { storeMatch: "MATCHED" },
      env: { THEME_WRITES_ENABLED: "false" },
    });
    expect(problems.join(" ")).toMatch(/Theme file writes are disabled/);
  });
});

describe("PageSpeed evidence for rendered findings", () => {
  it("records element, measured contrast, LCP element and script source without query strings", () => {
    const json = {
      lighthouseResult: {
        finalUrl: `https://${HOST}/`,
        categories: { performance: { score: 0.4 }, accessibility: { score: 0.8, auditRefs: [{ id: "color-contrast" }] } },
        audits: {
          "largest-contentful-paint": { numericValue: 5200 },
          "largest-contentful-paint-element": {
            details: { type: "list", items: [{ type: "table", items: [{ node: { nodeLabel: "Summer sale", selector: "div.hero > img", snippet: '<img src="https://cdn.example/hero.jpg?token=secret">' } }] }] },
          },
          "color-contrast": {
            score: 0,
            scoreDisplayMode: "binary",
            title: "Background and foreground colors do not have a sufficient contrast ratio.",
            details: { items: [{ node: { nodeLabel: "Shop now", selector: "a.button", explanation: "Fix any of the following:\n  Element has insufficient color contrast of 2.1 (foreground color: #aaaaaa, background color: #ffffff)" } }] },
          },
          "errors-in-console": { score: 0, details: { items: [{ source: "exception", description: "TypeError: x is undefined", sourceLocation: { url: "https://cdn.example/app.js?sig=abc" } }] } },
        },
      },
    };
    const r = parsePagespeed(json, { requestedUrl: `https://${HOST}/`, strategy: "MOBILE" });
    const ev = Object.fromEntries(r.findings.map((f) => [f.id, f.evidence]));
    expect(ev["perf.cwv.lcp"]).toMatch(/LCP element: "Summer sale" · selector div\.hero > img/);
    expect(ev["a11y.color-contrast"]).toMatch(/"Shop now" · selector a\.button · .*contrast of 2\.1 \(foreground color: #aaaaaa, background color: #ffffff\)/);
    expect(ev["code.console-errors"]).toMatch(/TypeError: x is undefined \(in https:\/\/cdn\.example\/app\.js\)/);
    expect(JSON.stringify(r.findings)).not.toMatch(/token=|sig=/);
  });
});
