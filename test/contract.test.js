/* eslint-env node */
// Source report contract (schemaVersion 1), normalisation, idempotent import,
// revision-bound approval, reconciliation and the SSRF-safe fetcher. All Shopify
// calls go to the in-memory fake; nothing here touches a real store or network.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXEC, STORE_MATCH, VERIFY } from "../app/fixes/constants";
import { getFixType, classifyFinding } from "../app/fixes/registry.server";
import { ImportError, parseAuditFile, SOURCE_FORMATS } from "../app/fixes/importer.server";
import { STRUCTURE_LIMITS, stableFindingId } from "../app/fixes/reportContract.server";
import { checkUrl, isPublicAddress, makeSafeLookup, safeFetchText, httpsRequestOnce } from "../app/fixes/safeFetch.server";
import {
  approvePlans,
  createImport,
  executePlans,
  findingsOf,
  prepareFinding,
  retryPlan,
  unapprovePlan,
} from "../app/fixes/service.server";
import { approvedFixesJson, finding, reportV1 } from "./helpers/auditBuilders";
import { createFakeShop } from "./helpers/fakeShopify";
import { createTestDb } from "./helpers/testDb";

const HOST = "www.example-store.com";
const URL1 = `https://${HOST}/products/blue-shirt`;
const json = (o) => JSON.stringify(o);

function importError(text) {
  try {
    parseAuditFile(text);
  } catch (err) {
    expect(err).toBeInstanceOf(ImportError);
    return err;
  }
  throw new Error("expected ImportError");
}

describe("schemaVersion 1 report: parsing", () => {
  const report = reportV1({
    findings: [
      finding("seo.meta-description.missing", "seo", [URL1]),
      finding("perf.cwv.lcp", "performance", [`https://${HOST}/`], { evidence: "LCP element: img.hero", fix: null }),
      finding("a11y.color-contrast", "accessibility", [`https://${HOST}/`]),
    ],
  });

  it("reads the actual field names, homepage metric nesting and provenance", () => {
    const r = parseAuditFile(json(report));
    expect(r.sourceFormat).toBe(SOURCE_FORMATS.V1);
    expect(r.legacy).toBe(false);
    expect(r.auditedHost).toBe("example-store.com");
    expect(r.overallScore).toBe(72);
    expect(r.contract).toMatchObject({
      contractVersion: 1,
      sourceSchemaVersion: 1,
      device: "desktop",
      narrativeGeneratedBy: "template",
      summaryNotes: [],
      unsupported: [],
    });
    expect(r.contract.generatedAt.toISOString()).toBe("2026-10-20T10:05:00.000Z");
    expect(r.contract.crawledAt.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(r.contract.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.contract.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    // cwv and cdpMetrics are homepage-only and nested exactly as the tool writes them.
    expect(r.contract.metrics).toMatchObject({
      scope: "homepage",
      fcpMs: 812,
      lcpMs: 1521,
      lcpElement: { tagName: "IMG", isLazyLoaded: true, hasFetchPriorityHigh: false },
      cls: 0.123,
      clsEntryCount: 1,
      longTaskCount: 1,
      blockingTimeMs: 70,
      cdp: { scriptDurationMs: 641, jsHeapUsedKb: 10240 },
    });
    expect(r.contract.pagesCrawled).toHaveLength(2);
    expect(r.contract.narrative.executiveSummary).toMatch(/several SEO fields/);
    const f = r.findings[0];
    expect(f).toMatchObject({ key: "seo.meta-description.missing", sourceId: "seo.meta-description.missing", pageCount: 1, instances: 1, known: true });
    expect(f.findingId).toMatch(/^f_[0-9a-f]{24}$/);
    expect(r.findings[1].audit).toBeNull(); // fix: null
    expect(r.findings[2].known).toBe(true); // a11y.<axe-rule-id>
  });

  it("derives stable finding ids from issue id, sorted normalised URLs and evidence", () => {
    const a = stableFindingId("seo.h1.missing", [`https://${HOST}/b/`, `https://${HOST.toUpperCase()}/a#x`], "ev");
    const b = stableFindingId("seo.h1.missing", [`https://${HOST}/a`, `https://${HOST}/b`], "ev");
    expect(a).toBe(b);
    expect(stableFindingId("seo.h1.missing", [`https://${HOST}/a`], "other")).not.toBe(b);
    expect(stableFindingId("seo.h1.multiple", [`https://${HOST}/a`, `https://${HOST}/b`], "ev")).not.toBe(b);
  });

  it("gives the same content digest for reformatted files, but a different raw hash", () => {
    const compact = parseAuditFile(json(report)).contract;
    const pretty = parseAuditFile(JSON.stringify(report, null, 2)).contract;
    expect(pretty.contentDigest).toBe(compact.contentDigest);
    expect(pretty.rawSha256).not.toBe(compact.rawSha256);
  });

  it("accepts nulls where the contract allows them and does not invent timestamps", () => {
    const r = parseAuditFile(json(reportV1({ findings: [finding("seo.og.missing", "seo", [], { url: null, evidence: null, fix: null })], cwv: null, cdpMetrics: null, generatedAt: undefined })));
    expect(r.contract.metrics).toBeNull();
    expect(r.contract.generatedAt).toBeNull();
    expect(r.findings[0].url).toBeNull();
  });

  it("keeps unknown issue ids visible as unsupported, never executable", () => {
    const r = parseAuditFile(json(reportV1({ findings: [finding("seo.robots.blocked", "seo", [URL1])] })));
    expect(r.findings).toHaveLength(1);
    expect(r.contract.unsupported[0]).toMatchObject({ key: "seo.robots.blocked", reason: expect.stringMatching(/Unknown issue id/) });
    expect(classifyFinding(r.findings[0])).toMatchObject({ status: "unsupported", actionClass: "unsupported" });
  });

  it("puts every known finding in one of the five action classes", () => {
    const cls = (id, urls = [URL1]) => classifyFinding(parseAuditFile(json(reportV1({ findings: [finding(id, "seo", urls)] }))).findings[0]).actionClass;
    expect(cls("seo.meta-description.missing")).toBe("admin_api");
    expect(cls("seo.title.length", [])).toBe("needs_evidence");
    expect(cls("seo.img.alt-missing")).toBe("needs_evidence");
    expect(cls("seo.lang.missing", [])).toBe("theme_patch");
    expect(cls("perf.cwv.lcp")).toBe("manual");
    expect(cls("seo.unknown-thing")).toBe("unsupported");
  });
});

describe("schemaVersion 1 report: rejection and hostile input", () => {
  it("rejects unsupported schema versions", () => {
    expect(importError(json({ ...reportV1({ findings: [finding("seo.og.missing", "seo", [])] }), schemaVersion: 2 })).message).toMatch(/schemaVersion 2/);
    expect(importError(json({ ...reportV1({ findings: [finding("seo.og.missing", "seo", [])] }), schemaVersion: "1" })).message).toMatch(/Unsupported report schemaVersion/);
  });

  it("rejects wrong field types and missing issue ids (never derived from prose)", () => {
    const bad = [
      { ...finding("seo.og.missing", "seo", []), pageCount: "3" },
      { ...finding("seo.h1.missing", "seo", []), fix: { fix_type: "x", risk: "extreme", autoApplicable: "yes" } },
      { ...finding("seo.h1.multiple", "seo", []), affectedUrls: [42] },
      { ...finding("seo.title.length", "seo", []), evidence: 5 },
      { ...finding("seo.canonical.missing", "seo", []), id: undefined, title: "Set the canonical tag on product pages" },
    ];
    const err = importError(json(reportV1({ findings: bad })));
    const details = err.details.join("\n");
    expect(details).toMatch(/"pageCount" must be a whole number/);
    expect(details).toMatch(/"fix.risk" must be low, medium or high/);
    expect(details).toMatch(/"fix.autoApplicable" must be true or false/);
    expect(details).toMatch(/"affectedUrls" must contain only text/);
    expect(details).toMatch(/"evidence" must be text or null/);
    expect(details).toMatch(/Finding #5: missing or invalid "id"/);
  });

  it("rejects malformed metrics and metadata", () => {
    expect(importError(json(reportV1({ findings: [finding("seo.og.missing", "seo", [])], cwv: "fast" }))).details.join()).toMatch(/"cwv" must be an object or null/);
    expect(importError(json(reportV1({ findings: [finding("seo.og.missing", "seo", [])], meta: { url: URL1, host: HOST, device: "tablet" } }))).details.join()).toMatch(/meta.device/);
  });

  it("rejects deep nesting, huge lists, huge strings and prototype keys", () => {
    let deep = {};
    const root = deep;
    for (let i = 0; i < STRUCTURE_LIMITS.maxDepth + 5; i++) deep = deep.x = {};
    expect(importError(json({ ...reportV1({ findings: [finding("seo.og.missing", "seo", [])] }), extra: root })).message).toMatch(/nested more than/);
    expect(importError(json({ ...reportV1({ findings: [finding("seo.og.missing", "seo", [])] }), extra: Array(STRUCTURE_LIMITS.maxArrayLength + 1).fill(0) })).message).toMatch(/list longer than/);
    expect(importError(json({ ...reportV1({ findings: [finding("seo.og.missing", "seo", [])] }), extra: "x".repeat(STRUCTURE_LIMITS.maxStringLength + 1) })).message).toMatch(/too long/);
    const base = json(reportV1({ findings: [finding("seo.og.missing", "seo", [])] }));
    expect(importError(base.replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{"isAdmin":true}')).message).toMatch(/forbidden key/);
    expect(importError(base.replace('"title":"Finding seo.og.missing"', '"title":"t","constructor":{"prototype":{}}')).message).toMatch(/forbidden key/);
    expect({}.isAdmin).toBeUndefined();
  });

  it("flags inconsistent duplicated summaries without trusting either", () => {
    const r = reportV1({ findings: [finding("seo.og.missing", "seo", [])] });
    r.summary.overall = 99;
    r.summary.totalFindings = 7;
    r.counts.critical = 4;
    const parsed = parseAuditFile(json(r));
    const notes = parsed.contract.summaryNotes.join("\n");
    expect(notes).toMatch(/summary.overall differs/);
    expect(notes).toMatch(/totalFindings \(7\)/);
    expect(notes).toMatch(/severity counts do not match/);
    expect(parsed.warnings.join()).toMatch(/Summary check/);
  });

  it("blocks matching when meta.host and meta.url disagree", () => {
    const r = parseAuditFile(json(reportV1({ findings: [finding("seo.og.missing", "seo", [])], meta: { url: "https://www.example-store.com/", host: "other-store.com", crawledAt: "2026-10-20T10:00:00.000Z", device: "mobile" } })));
    expect(r.auditedHost).toBeNull();
    expect(r.warnings.join()).toMatch(/disagree/);
  });

  it("keeps the legacy formats explicit and labelled", () => {
    const r = parseAuditFile(approvedFixesJson({ fixes: [finding("seo.og.missing", "seo", [])] }));
    expect(r.legacy).toBe(true);
    expect(r.contract.sourceSchemaVersion).toBeNull();
    expect(r.warnings[0]).toMatch(/not treated as approval/);
  });
});

// ------------------------------------------------------------ service level

let testDb;
let db;
beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
});
afterAll(async () => testDb.cleanup());

let fake;
let product;
let base;
beforeEach(() => {
  fake = createFakeShop({ shop: `c-${Math.random().toString(36).slice(2, 8)}.myshopify.com`, primaryHost: HOST });
  product = fake.api.addProduct({ title: "Blue Shirt", handle: "blue-shirt", description: "" });
  base = { db, admin: fake.admin, session: fake.session };
});
const mutations = () => fake.state.calls.filter((c) => /Update|Upsert/.test(c.name));
const VALUE = "A blue cotton shirt for everyday wear, available in several sizes.";

async function v1Plan(findings = [finding("seo.meta-description.missing", "seo", [URL1])]) {
  const imp = await createImport({ ...base, text: json(reportV1({ findings })) });
  await prepareFinding({ ...base, importId: imp.id, findingKey: findings[0].id });
  const [plan] = await db.fixExecution.findMany({ where: { importId: imp.id } });
  return { imp, plan };
}

describe("import: idempotency and shop isolation", () => {
  it("returns the existing import for identical content in the same shop only", async () => {
    const report = reportV1({ findings: [finding("seo.meta-description.missing", "seo", [URL1])] });
    const a = await createImport({ ...base, text: json(report) });
    const b = await createImport({ ...base, text: JSON.stringify(report, null, 4) });
    expect(b.id).toBe(a.id);
    expect(b.duplicate).toBe(true);
    expect(a).toMatchObject({ contractVersion: 1, sourceSchemaVersion: 1, sourceFormat: SOURCE_FORMATS.V1 });

    const other = createFakeShop({ shop: "someone-else.myshopify.com", primaryHost: HOST });
    const c = await createImport({ db, admin: other.admin, session: other.session, text: json(report) });
    expect(c.id).not.toBe(a.id);
    expect(c.shop).toBe("someone-else.myshopify.com");
  });

  it("never creates approvals or changes from imported content", async () => {
    const fixes = [finding("seo.meta-description.missing", "seo", [URL1], { fix: { fix_type: "set_meta_admin", risk: "low", autoApplicable: true, generated_fix: "x" } })];
    const imp = await createImport({ ...base, text: approvedFixesJson({ fixes }) });
    expect(await db.fixExecution.count({ where: { importId: imp.id } })).toBe(0);
    expect(mutations()).toHaveLength(0);
  });

  it("blocks wrong-store reports from preparing changes", async () => {
    const imp = await createImport({ ...base, text: json(reportV1({ host: "www.another-store.com", findings: [finding("seo.meta-description.missing", "seo", ["https://www.another-store.com/products/blue-shirt"])] })) });
    expect(imp.storeMatch).toBe(STORE_MATCH.MISMATCH);
    await expect(prepareFinding({ ...base, importId: imp.id, findingKey: "seo.meta-description.missing" })).rejects.toMatchObject({ code: "STORE_NOT_CONFIRMED" });
  });

  it("refuses to prepare conflicting duplicate findings", async () => {
    const f = finding("seo.meta-description.missing", "seo", [URL1]);
    const imp = await createImport({ ...base, text: json(reportV1({ findings: [f, { ...f, severity: "critical" }] })) });
    expect(findingsOf(imp)[0].conflict).toBe(true);
    await expect(prepareFinding({ ...base, importId: imp.id, findingKey: f.id })).rejects.toMatchObject({ code: "UNSUPPORTED_FINDING" });
  });

  it("does not resolve /collections/all or feed URLs to a resource", async () => {
    fake.api.addCollection({ title: "All", handle: "all" });
    const { imp } = await v1Plan([finding("seo.meta-description.missing", "seo", [`https://${HOST}/collections/all`, `https://${HOST}/products/blue-shirt.json`])]);
    expect(await db.fixExecution.count({ where: { importId: imp.id } })).toBe(0);
  });

  it("rejects a lookup result whose handle differs from the requested one", async () => {
    fake.state.interceptors.StoreAuditProductByHandle = () => new Response(JSON.stringify({ data: { productByIdentifier: { id: product.id, title: product.title, handle: "something-else" } } }));
    const { imp } = await v1Plan();
    expect(await db.fixExecution.count({ where: { importId: imp.id } })).toBe(0);
  });
});

describe("approval binds one revision", () => {
  it("rejects an approval for a revision the merchant did not review", async () => {
    const { imp, plan } = await v1Plan();
    const r = await approvePlans({ ...base, importId: imp.id, items: [{ planId: plan.id, seenRevision: plan.revision - 1, value: VALUE, seenBefore: null }] });
    expect(r[0]).toMatchObject({ ok: false, code: "REVIEW_OUTDATED" });
    const missing = await approvePlans({ ...base, importId: imp.id, items: [{ planId: plan.id, value: VALUE, seenBefore: null }] });
    expect(missing[0]).toMatchObject({ ok: false, code: "REVIEW_OUTDATED" });
  });

  it("invalidates the approval when the change is edited or re-reviewed", async () => {
    const { imp, plan } = await v1Plan();
    await approvePlans({ ...base, importId: imp.id, items: [{ planId: plan.id, seenRevision: plan.revision, value: VALUE, seenBefore: null }] });
    const approved = await db.fixExecution.findUnique({ where: { id: plan.id } });
    expect(approved.revision).toBe(plan.revision + 1);
    expect(JSON.parse(approved.approvedJson).revision).toBe(approved.revision);

    // Returned to review: the old approval revision can no longer be used.
    await unapprovePlan({ ...base, planId: plan.id });
    const again = await approvePlans({ ...base, importId: imp.id, items: [{ planId: plan.id, seenRevision: approved.revision, value: VALUE, seenBefore: null }] });
    expect(again[0]).toMatchObject({ ok: false, code: "REVIEW_OUTDATED" });
  });

  it("refuses to execute an approval whose revision no longer matches", async () => {
    const { imp, plan } = await v1Plan();
    await approvePlans({ ...base, importId: imp.id, items: [{ planId: plan.id, seenRevision: plan.revision, value: VALUE, seenBefore: null }] });
    // Simulates a concurrent edit that bumped the revision without clearing the approval.
    await db.fixExecution.update({ where: { id: plan.id }, data: { revision: { increment: 1 } } });
    const { results } = await executePlans({ ...base, importId: imp.id, planIds: [plan.id], sleep: async () => {} });
    expect(results[0]).toMatchObject({ ok: false, code: "APPROVAL_MISMATCH" });
    expect(mutations()).toHaveLength(0);
  });
});

describe("reconciliation after an ambiguous failure", () => {
  async function failedAfterSend(saved) {
    const { imp, plan } = await v1Plan();
    await approvePlans({ ...base, importId: imp.id, items: [{ planId: plan.id, seenRevision: plan.revision, value: VALUE, seenBefore: null }] });
    // The write may or may not have reached Shopify before the connection dropped.
    fake.state.interceptors.StoreAuditProductSeoUpdate = () => {
      if (saved) product.seo.description = VALUE;
      throw Object.assign(new Error("socket hang up"), { name: "FetchError" });
    };
    const { results } = await executePlans({ ...base, importId: imp.id, planIds: [plan.id], sleep: async () => {} });
    expect(results[0].ok).toBe(false);
    delete fake.state.interceptors.StoreAuditProductSeoUpdate;
    return plan;
  }

  it("records the change as applied (read back) when Shopify already has the value, without re-sending", async () => {
    const plan = await failedAfterSend(true);
    const sentBefore = mutations().length;
    const r = await retryPlan({ ...base, planId: plan.id });
    expect(r).toMatchObject({ reconciled: true });
    const row = await db.fixExecution.findUnique({ where: { id: plan.id } });
    expect(row).toMatchObject({ status: EXEC.APPLIED, verificationStatus: VERIFY.PASSED });
    expect(JSON.parse(row.resultJson).reconciled).toBe(true);
    expect(mutations().length).toBe(sentBefore);
  });

  it("returns the change to review when the value was not saved", async () => {
    const plan = await failedAfterSend(false);
    const r = await retryPlan({ ...base, planId: plan.id });
    expect(r).toMatchObject({ reconciled: false });
    const row = await db.fixExecution.findUnique({ where: { id: plan.id } });
    expect(row.status).toBe(EXEC.NEEDS_REVIEW);
    expect(row.approvedJson).toBeNull();
  });
});

describe("theme and Admin allowlist stay closed", () => {
  it("keeps theme writes disabled by default", () => {
    const def = getFixType("theme_html_lang");
    expect(def.handler).toBeTruthy();
    expect(process.env.THEME_WRITES_ENABLED).not.toBe("true");
  });
  it("rejects fix types outside the registry", () => {
    expect(() => getFixType("product_price")).toThrowError(/not supported/);
    expect(() => getFixType("__proto__")).toThrowError(/not supported/);
  });
});

// ------------------------------------------------------------ SSRF-safe fetch

describe("safe storefront fetch", () => {
  it("classifies public and non-public IPv4 and IPv6 addresses", () => {
    for (const ip of ["23.227.38.65", "8.8.8.8", "2606:4700::1111", "2620:127:f00f:e::"]) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe", "2002:7f00:0001::", "2001:db8::1", "ff02::1", "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("only allows https on the default port, without credentials, to allowlisted hosts", () => {
    const allowed = [HOST];
    expect(() => checkUrl(`http://${HOST}/`, allowed)).toThrowError(/Only https/);
    expect(() => checkUrl(`https://user:pw@${HOST}/`, allowed)).toThrowError(/credentials/);
    expect(() => checkUrl(`https://${HOST}:8443/`, allowed)).toThrowError(/default https port/);
    expect(() => checkUrl("https://evil.example/", allowed)).toThrowError(/not on the allowlist/);
    expect(() => checkUrl("https://127.0.0.1/", ["127.0.0.1"])).toThrowError(/non-public/);
    expect(checkUrl(`https://${HOST}/products/x`, allowed).hostname).toBe(HOST);
  });

  it("refuses DNS answers that contain any non-public address (rebinding protection)", async () => {
    const lookup = makeSafeLookup((host, opts, cb) => cb(null, [{ address: "23.227.38.65", family: 4 }, { address: "10.0.0.5", family: 4 }]));
    const err = await new Promise((resolve) => lookup(HOST, { all: true }, (e) => resolve(e)));
    expect(err.code).toBe("BLOCKED_ADDRESS");
    const ok = await new Promise((resolve) =>
      makeSafeLookup((h, o, cb) => cb(null, [{ address: "23.227.38.65", family: 4 }]))(HOST, {}, (e, address) => resolve({ e, address })),
    );
    expect(ok).toEqual({ e: null, address: "23.227.38.65" });
  });

  it("validates every redirect hop and bounds the number of redirects", async () => {
    const hop = (location) => ({ status: 301, headers: { location }, text: "", truncated: false });
    const evil = vi.fn().mockResolvedValueOnce(hop("https://169.254.169.254/latest/meta-data"));
    await expect(safeFetchText(`https://${HOST}/a`, { allowedHosts: [HOST, "169.254.169.254"], maxRedirects: 3, requestOnce: evil })).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    const offsite = vi.fn().mockResolvedValueOnce(hop("https://attacker.example/"));
    await expect(safeFetchText(`https://${HOST}/a`, { allowedHosts: [HOST], maxRedirects: 3, requestOnce: offsite })).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
    const loop = vi.fn(async () => hop(`https://${HOST}/again`));
    const r = await safeFetchText(`https://${HOST}/a`, { allowedHosts: [HOST], maxRedirects: 2, requestOnce: loop });
    expect(loop).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ status: 301, redirects: 2 });
    const manual = vi.fn(async () => hop(`https://${HOST}/password`));
    expect(await safeFetchText(`https://${HOST}/a`, { allowedHosts: [HOST], requestOnce: manual })).toMatchObject({ status: 301, redirects: 0 });
  });

  it("blocks a real connection attempt to a host that resolves to loopback", async () => {
    await expect(safeFetchText("https://localhost/", { allowedHosts: ["localhost"], requestOnce: httpsRequestOnce, timeoutMs: 3000 })).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
  });
});
