/* eslint-env node */
// Dry run of the audit-fix workflow, end to end, against an IN-MEMORY fake
// Shopify Admin API and a throwaway SQLite database. Nothing touches a real store.
//
//   npm run dry-run -- <audit.json> [--theme-writes] [--shop-host www.example.com]
//
// The fake store is seeded from the audit's own URLs: every /products/<handle> and
// /collections/<handle> becomes a resource with unset SEO fields and images without
// alt text, plus a live and an unpublished theme whose layout lacks lang/canonical.

import fs from "fs";
import { EXEC, VERIFY } from "../app/fixes/constants";
import { FIX_TYPES, fixTypesForAuditId, manualReason } from "../app/fixes/registry.server";
import { classifyStoreUrl } from "../app/fixes/resolve.server";
import {
  approvePlans,
  batchToken,
  createImport,
  executePlans,
  findingsOf,
  prepareFinding,
} from "../app/fixes/service.server";
import { createFakeShop } from "../test/helpers/fakeShopify";
import { createTestDb } from "../test/helpers/testDb";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const themeWrites = args.includes("--theme-writes");
const hostArg = args.includes("--shop-host") ? args[args.indexOf("--shop-host") + 1] : null;
if (!file) {
  console.error("Usage: npm run dry-run -- <audit.json> [--theme-writes] [--shop-host host]");
  process.exit(1);
}

const env = themeWrites ? { THEME_WRITES_ENABLED: "true" } : {};
const line = (s = "") => console.log(s);
const head = (s) => line(`\n=== ${s} ${"=".repeat(Math.max(0, 70 - s.length))}`);
const show = (v) => (v === null || v === undefined || v === "" ? "(not set)" : JSON.stringify(v));
const titleCase = (h) => h.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

const text = fs.readFileSync(file, "utf8");
const raw = JSON.parse(text);
const auditHost = raw.meta?.host || raw.meta?.store;
const shopHost = hostArg || (auditHost && auditHost.includes(".") ? auditHost : "www.dry-run-store.com");

const { db, cleanup } = await createTestDb();
const fake = createFakeShop({ shop: "dry-run-store.myshopify.com", primaryHost: shopHost, name: "Dry Run Store" });
const base = { db, admin: fake.admin, session: fake.session };

try {
  // ---- seed the fake store from the audit's URLs
  const rawFindings = raw.findings || raw.analysis?.findings || raw.fixes || [];
  const seeded = new Set();
  for (const f of rawFindings) {
    for (const u of [f.url, ...(f.affectedUrls || [])].filter(Boolean)) {
      const c = classifyStoreUrl(u, shopHost);
      const key = `${c.kind}:${c.handle}`;
      if (seeded.has(key)) continue;
      if (c.kind === "product") {
        fake.api.addProduct({
          title: titleCase(c.handle),
          handle: c.handle,
          description: `${titleCase(c.handle)} from our store. Each bottle is packed and sealed for freshness. See the label for ingredients, usage directions and storage information before use.`,
          images: [{ alt: "" }, { alt: "" }, { alt: "Existing alt text" }],
        });
        seeded.add(key);
      } else if (c.kind === "collection") {
        fake.api.addCollection({ title: titleCase(c.handle), handle: c.handle, description: "" });
        seeded.add(key);
      }
    }
  }
  const layout = '<!doctype html>\n<html class="no-js">\n  <head>\n    <meta charset="utf-8">\n    <title>{{ page_title }}</title>\n  </head>\n  <body>{{ content_for_layout }}</body>\n</html>';
  const live = fake.api.addTheme({ name: "Dawn", role: "MAIN", files: { "layout/theme.liquid": layout } });
  const draft = fake.api.addTheme({ name: "Dawn (copy for fixes)", role: "UNPUBLISHED", files: { "layout/theme.liquid": layout } });

  head("1. IMPORT");
  const imp = await createImport({ ...base, text, fileName: file.split(/[\\/]/).pop() });
  const findings = findingsOf(imp);
  line(`File:           ${imp.fileName} (${imp.sourceFormat})`);
  line(`Audited host:   ${imp.auditedHost ?? "(none)"}   Score: ${imp.overallScore ?? "n/a"} ${imp.grade ?? ""}`);
  line(`Session shop:   ${fake.session.shop} (primary domain ${shopHost})`);
  line(`Store match:    ${imp.storeMatch} – ${imp.storeMatchNote}`);
  line(`Findings:       ${findings.length}   Store writes during import: ${fake.state.calls.filter((c) => /Update|Upsert/.test(c.name)).length}`);
  for (const w of JSON.parse(imp.importWarnings || "[]").slice(0, 5)) line(`  note: ${w}`);

  head("2. DASHBOARD");
  const bySev = {};
  for (const f of findings) bySev[f.severity] = (bySev[f.severity] || 0) + 1;
  line(`By severity: ${JSON.stringify(bySev)}`);
  const supported = findings.filter((f) => fixTypesForAuditId(f.auditId).length);
  line(`Automatic fix available: ${supported.length}   Manual: ${findings.length - supported.length}`);
  for (const f of findings) {
    const defs = fixTypesForAuditId(f.auditId);
    line(`  [${f.severity.padEnd(8)}] ${f.displayCategory.padEnd(13)} ${f.auditId.padEnd(30)} ${defs.length ? `AUTO: ${defs.map((d) => d.type).join(", ")}` : "MANUAL"}`);
  }
  const manualSample = findings.find((f) => !fixTypesForAuditId(f.auditId).length);
  if (manualSample) line(`  e.g. why ${manualSample.auditId} is manual: ${manualReason(manualSample)}`);

  head("3. PREPARE (read-only)");
  for (const f of supported) {
    const needsTheme = fixTypesForAuditId(f.auditId).some((d) => d.executionKind === "theme");
    try {
      // The dry run plays a merchant who also opts into "related improvements".
      const r = await prepareFinding({ ...base, importId: imp.id, findingKey: f.key, themeId: needsTheme ? draft.id : null, acknowledgeUnconfirmed: true });
      line(`${f.auditId}: ${r.created} change(s) prepared`);
      for (const m of r.manual) line(`    manual: ${m.url ?? ""} – ${m.reason}`);
    } catch (err) {
      line(`${f.auditId}: NOT PREPARED – [${err.code}] ${err.message}`);
    }
  }
  const prepared = await db.fixExecution.findMany({ where: { importId: imp.id }, orderBy: { createdAt: "asc" } });
  line(`Store writes during prepare: ${fake.state.calls.filter((c) => /Update|Upsert/.test(c.name)).length}`);

  if (!prepared.length) {
    line("\nNo changes could be prepared (store not matched or nothing fixable). Dry run ends here.");
  } else {
    head("4. REVIEW (before -> proposed)");
    for (const p of prepared) {
      const before = JSON.parse(p.beforeJson);
      const proposed = JSON.parse(p.proposedJson);
      const field = { product_seo_title: "seoTitle", collection_seo_title: "seoTitle", product_seo_description: "seoDescription", collection_seo_description: "seoDescription", product_image_alt: "alt" }[p.fixType];
      line(`- ${FIX_TYPES[p.fixType].label} | ${p.resourceLabel}`);
      if (field) {
        line(`    before:   ${show(before[field])}`);
        line(`    proposed: ${show(proposed.value)}`);
        line(`    note:     ${proposed.note}`);
      } else {
        line(`    ${proposed.summary} (theme "${before.themeName}", role ${before.role})`);
        line(`    diff from line ${proposed.diff.startLine}:`);
        proposed.diff.before.forEach((l) => line(`      - ${l}`));
        proposed.diff.after.forEach((l) => line(`      + ${l}`));
      }
    }

    head("5. APPROVE (merchant accepts suggestions; empty suggestions need input)");
    // Same payload the review screen sends: the value plus what the merchant saw.
    const items = prepared.map((p) => {
      const def = FIX_TYPES[p.fixType];
      const proposed = JSON.parse(p.proposedJson);
      return p.executionKind === "theme"
        ? { planId: p.id, seenRevision: p.revision, seenProposed: proposed.value }
        : { planId: p.id, seenRevision: p.revision, value: proposed.value, seenBefore: def.handler.beforeValue(JSON.parse(p.beforeJson)) };
    });
    const approvals = await approvePlans({ ...base, importId: imp.id, items, env });
    for (const a of approvals) {
      const p = prepared.find((x) => x.id === a.planId);
      line(`  ${a.ok ? "APPROVED " : "REJECTED "} ${p.resourceLabel} ${a.ok ? (a.warnings?.length ? `(warnings: ${a.warnings.join(" ")})` : "") : `– ${a.message}`}`);
    }

    head("6. CONFIRM AND APPLY");
    const approvedIds = approvals.filter((a) => a.ok).map((a) => a.planId);
    const confirmed = batchToken(await db.fixExecution.findMany({ where: { id: { in: approvedIds } } }));
    const { results } = await executePlans({ ...base, importId: imp.id, planIds: approvedIds, expectedBatchToken: confirmed, env, sleep: async () => {} });
    for (const r of results) {
      const p = prepared.find((x) => x.id === r.planId);
      line(`  ${String(r.status).padEnd(8)} verification=${String(r.verificationStatus ?? "-").padEnd(10)} ${p.resourceLabel}: ${r.message ?? ""}`);
    }

    head("7. SAFETY CHECKS");
    const again = await executePlans({ ...base, importId: imp.id, planIds: approvedIds, env, sleep: async () => {} });
    line(`Re-submitting the same execution: ${again.results.filter((r) => r.ok).length} executed (expected 0)`);
    line(`Live theme layout unchanged: ${live.files["layout/theme.liquid"] === layout}`);
    line(`Theme publish operations sent: ${fake.state.calls.filter((c) => /publish/i.test(c.name)).length}`);
    const ops = [...new Set(fake.state.calls.map((c) => c.name))];
    line(`Distinct Admin API operations used: ${ops.join(", ")}`);

    head("8. EXECUTION HISTORY");
    const rows = await db.fixExecution.findMany({ where: { shop: fake.session.shop }, orderBy: { updatedAt: "asc" } });
    const counts = {};
    for (const r of rows) {
      const k = `${r.status}/${r.verificationStatus}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(counts)) line(`  ${k.padEnd(28)} ${n}`);
    const failedVerification = rows.filter((r) => r.status === EXEC.APPLIED && r.verificationStatus !== VERIFY.PASSED);
    line(`Applied but not verified: ${failedVerification.length}`);
    const backups = await db.themeFileBackup.count({ where: { shop: fake.session.shop } });
    line(`Theme file backups stored: ${backups}`);
  }
} finally {
  await cleanup();
}
