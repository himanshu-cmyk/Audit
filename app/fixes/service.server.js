// Fix execution service. Every function takes the authenticated `session` and
// `admin` client from authenticate.admin(); the shop is always session.shop and
// every database read/write is scoped to it.
//
// Lifecycle of one change (FixExecution):
//   prepare  -> NEEDS_REVIEW   (current values fetched, suggestion proposed)
//   approve  -> APPROVED       (merchant value validated, before-state re-checked)
//   execute  -> APPLYING       (atomic claim; prevents duplicate execution)
//            -> APPLIED + verification PASSED / FAILED / PENDING / UNAVAILABLE
//            -> STALE          (resource changed since approval; nothing sent)
//            -> FAILED         (error recorded; retry requires a fresh review)

import crypto from "crypto";
import { EXEC, EXEC_LABELS, STORE_MATCH, VERIFY, proposalState } from "./constants";
import { FixError } from "./graphql.server";
import { parseAuditFile } from "./importer.server";
import {
  classifyFinding,
  eligibilityProblems,
  fixTypesForAuditId,
  getFixType,
  grantedScopes,
  rootCauseConfirmed,
} from "./registry.server";
import { WRITABLE_THEME_ROLES, listThemes } from "./handlers/theme.server";
import { CONTRACT_VERSION, canonicalJson, sha256 } from "./reportContract.server";
import { SOURCE_FORMATS } from "./importer.server";
import { runAudit } from "../audit/engine.server";
import { classifyStoreUrl, lookupByHandle } from "./resolve.server";
import {
  canModifyStore,
  evaluateStoreMatch,
  fetchShopInfo,
  validateStoreConfirmation,
} from "./storeMatch.server";
import { cleanLine, safeJsonParse } from "./text";
import { unsupportedClaims } from "../ai/schema.server";

const ID_RE = /^[a-z0-9]{10,40}$/i;
const MAX_URLS_PER_PREPARE = 50;
const STUCK_APPLYING_MS = 10 * 60 * 1000;

export function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function stripContent(current) {
  // Never persist full theme file content in plan snapshots (backups are separate).
  // eslint-disable-next-line no-unused-vars
  const { content, ...rest } = current || {};
  return rest;
}

function ctxFor({ admin, db, session, sleep, jobPolls, shopName }) {
  return { admin, db, shop: session.shop, sleep, jobPolls, shopName };
}

const normValue = (v) => (typeof v === "string" ? v.trim() : "");

// Binds an approval to exactly one shop, revision, finding, resource, fix type,
// value and before-state. Recomputed at execution; any difference voids the approval.
// Keyed with the app secret when available so it cannot be recomputed from data alone.
export function approvalHash(plan, shop, value, beforeValue, revision) {
  const payload = JSON.stringify([
    shop,
    revision ?? null,
    plan.importId,
    plan.findingKey,
    plan.fixType,
    plan.resourceType,
    plan.resourceId,
    plan.parentResourceId ?? null,
    plan.rollbackOfId ?? null,
    value,
    beforeValue ?? null,
  ]);
  const key = process.env.SHOPIFY_API_SECRET;
  return key
    ? crypto.createHmac("sha256", key).update(payload).digest("hex")
    : crypto.createHash("sha256").update(payload).digest("hex");
}

// Identifies one exact batch of approved changes (ids + approvals). The merchant
// confirms this token; if any approval changes, the token no longer matches.
export function batchToken(plans) {
  const parts = plans
    .map((p) => `${p.id}:${safeJsonParse(p.approvedJson, {})?.hash ?? ""}`)
    .sort();
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

// Rollback plans may only restore the exact, server-recorded previous value.
function validateFor(def, plan, value, current) {
  if (plan.rollbackOfId && plan.executionKind !== "theme") {
    const proposed = safeJsonParse(plan.proposedJson, {});
    return typeof value === "string" && value === proposed.value
      ? { ok: true, value, errors: [], warnings: [] }
      : { ok: false, value: null, errors: ["The restore value does not match the recorded previous value."], warnings: [] };
  }
  return def.handler.validate(value, current, plan);
}

const ROOT_CAUSE_CODES = ["ROOT_CAUSE_NOT_ADMIN_DATA", "ROOT_CAUSE_UNCONFIRMED", "PATCH_NOT_APPLICABLE", "MEDIA_NOT_READY"];

// ---------------------------------------------------------------- imports

// Importing records validated findings only. Identical content re-imported in the
// same shop returns the existing import (with its own review state); nothing in a
// file can carry or restore an approval.
export async function createImport({ db, admin, session, text, fileName }) {
  const parsed = parseAuditFile(text);
  const c = parsed.contract;
  const existing = await db.auditImport.findFirst({ where: { shop: session.shop, contentDigest: c.contentDigest } });
  if (existing) return { ...existing, duplicate: true };
  const shopInfo = await fetchShopInfo(admin);
  const match = evaluateStoreMatch(parsed.auditedHost, session.shop, shopInfo);
  try {
    return await db.auditImport.create({
      data: {
        shop: session.shop,
        sourceFormat: parsed.sourceFormat,
        fileName: cleanLine(fileName, 200),
        auditedUrl: parsed.auditedUrl,
        auditedHost: parsed.auditedHost,
        auditDate: parsed.auditDate,
        overallScore: parsed.overallScore,
        grade: parsed.grade,
        findingCount: parsed.findings.length,
        findingsJson: JSON.stringify(parsed.findings),
        importWarnings: parsed.warnings.length ? JSON.stringify(parsed.warnings) : null,
        storeMatch: match.status,
        storeMatchNote: match.note,
        contractVersion: c.contractVersion,
        sourceSchemaVersion: c.sourceSchemaVersion,
        rawSha256: c.rawSha256,
        contentDigest: c.contentDigest,
        sourceGeneratedAt: c.generatedAt,
        reportJson: JSON.stringify({
          crawledAt: c.crawledAt,
          device: c.device,
          narrativeGeneratedBy: c.narrativeGeneratedBy,
          pagesCrawled: c.pagesCrawled,
          metrics: c.metrics,
          narrative: c.narrative,
          summaryNotes: c.summaryNotes,
          unsupported: c.unsupported,
        }),
      },
    });
  } catch (err) {
    // A concurrent upload of the same content won the unique (shop, contentDigest).
    if (err?.code !== "P2002") throw err;
    const row = await db.auditImport.findFirst({ where: { shop: session.shop, contentDigest: c.contentDigest } });
    if (!row) throw err;
    return { ...row, duplicate: true };
  }
}

// Runs the in-app audit on the authenticated shop and stores it like an import.
// The audit reads Admin data, the published theme and (optionally) public
// storefront pages of the shop's own domain. It never changes the store.
const AUDIT_COOLDOWN_MS = 60 * 1000;

// storefrontPassword is used for this run only: it is passed to the audit and is
// never stored, logged or included in the report.
export async function createInAppAudit({
  db,
  admin,
  session,
  includeStorefront = true,
  storefrontPassword = null,
  themeId = null,
  fetchPage,
  pagespeedFetch,
  lighthouseRun,
  env,
  storefrontClientOptions,
}) {
  const selectedTheme = themeId ? await assertWritableTheme(admin, themeId) : null;
  const recent = await db.auditImport.findFirst({
    where: { shop: session.shop, sourceFormat: SOURCE_FORMATS.IN_APP, createdAt: { gt: new Date(Date.now() - AUDIT_COOLDOWN_MS) } },
  });
  if (recent) throw new FixError("AUDIT_TOO_SOON", "An audit was started less than a minute ago. Open it from the list below, or wait a moment.");
  const shopInfo = await fetchShopInfo(admin);
  const { host, startedAt, findings, report } = await runAudit({
    admin,
    shopInfo,
    scopes: grantedScopes(session),
    includeStorefront,
    storefrontPassword: includeStorefront && typeof storefrontPassword === "string" && storefrontPassword ? storefrontPassword.slice(0, 200) : null,
    ...(fetchPage ? { fetchPage } : {}),
    ...(pagespeedFetch ? { pagespeedFetch } : {}),
    ...(lighthouseRun ? { lighthouseRun } : {}),
    ...(env ? { env } : {}),
    ...(storefrontClientOptions ? { storefrontClientOptions } : {}),
  });
  const content = canonicalJson({ shop: session.shop, startedAt: startedAt.toISOString(), findings });
  return db.auditImport.create({
    data: {
      shop: session.shop,
      sourceFormat: SOURCE_FORMATS.IN_APP,
      fileName: null,
      auditedUrl: `https://${host}/`,
      auditedHost: host,
      auditDate: startedAt,
      overallScore: report.score.overall,
      grade: report.score.grade,
      findingCount: findings.length,
      findingsJson: JSON.stringify(findings),
      importWarnings: null,
      // The audit read this shop's own data through its authenticated session.
      storeMatch: STORE_MATCH.MATCHED,
      storeMatchNote: "Audit run by this app on this store's own data.",
      contractVersion: CONTRACT_VERSION,
      sourceSchemaVersion: null,
      rawSha256: null,
      contentDigest: sha256(content),
      sourceGeneratedAt: startedAt,
      reportJson: JSON.stringify(report),
      themeId: selectedTheme?.id ?? null,
    },
  });
}

async function assertWritableTheme(admin, themeId) {
  const theme = (await listThemes(admin)).find((t) => t.id === themeId);
  if (!theme) throw new FixError("NOT_FOUND", "That theme was not found in this store.");
  if (!WRITABLE_THEME_ROLES.includes(theme.role)) {
    throw new FixError("LIVE_THEME", "Choose an unpublished or development theme. The app never edits the live theme.");
  }
  return theme;
}

// Records the one theme that theme fixes for this audit are prepared against.
export async function setImportTheme({ db, admin, session, importId, themeId }) {
  const imp = await requireImport(db, session.shop, importId);
  const theme = await assertWritableTheme(admin, String(themeId || ""));
  await db.auditImport.update({ where: { id: imp.id }, data: { themeId: theme.id } });
  return theme;
}

// Prepares every finding the app can fix, in one go. Each change is still only
// a proposal: it must be reviewed, approved and confirmed before anything runs.
export async function prepareAllFixable({ db, admin, session, importId }) {
  const imp = await requireImport(db, session.shop, importId);
  const totals = { findings: 0, created: 0, updated: 0, unchanged: 0, prepared: 0, manual: [], unresolved: [], failed: [], skipped: [] };
  for (const f of findingsOf(imp)) {
    const c = classifyFinding(f);
    if (c.status !== "auto") continue;
    if (c.actionClass === "theme_patch" && !imp.themeId) {
      totals.skipped.push({ key: f.key, reason: "No theme chosen for theme fixes." });
      continue;
    }
    try {
      const r = await prepareFinding({ db, admin, session, importId: imp.id, findingKey: f.key });
      totals.findings++;
      totals.created += r.created;
      totals.updated += r.updated;
      totals.unchanged += r.unchanged;
      totals.prepared += r.prepared;
      totals.manual.push(...r.manual.map((m) => ({ ...m, key: f.key })));
      totals.unresolved.push(...r.unresolved.map((m) => ({ ...m, key: f.key })));
      totals.failed.push(...r.failed.map((m) => ({ ...m, key: f.key })));
    } catch (err) {
      if (!(err instanceof FixError) || err.code === "SESSION_EXPIRED") throw err;
      totals.skipped.push({ key: f.key, reason: err.message });
    }
  }
  return totals;
}

export async function loadImport(db, shop, importId) {
  if (!isValidId(importId)) return null;
  return db.auditImport.findFirst({ where: { id: importId, shop } });
}

async function requireImport(db, shop, importId) {
  const imp = await loadImport(db, shop, importId);
  if (!imp) throw new FixError("NOT_FOUND", "Audit import not found.");
  return imp;
}

export function findingsOf(importRecord) {
  return safeJsonParse(importRecord.findingsJson, []);
}

export async function confirmStore({ db, session, importId, typedHost, acknowledged }) {
  const imp = await requireImport(db, session.shop, importId);
  const problem = validateStoreConfirmation(imp, typedHost, acknowledged);
  if (problem) throw new FixError("CONFIRMATION_INVALID", problem);
  return db.auditImport.update({
    where: { id: imp.id },
    data: { storeConfirmedAt: new Date(), storeConfirmedHost: imp.auditedHost },
  });
}

// ---------------------------------------------------------------- prepare

export async function prepareFinding({ db, admin, session, importId, findingKey, themeId, acknowledgeUnconfirmed = false }) {
  const imp = await requireImport(db, session.shop, importId);
  // The theme is chosen once per audit; an explicit themeId (tests, scripts) wins.
  themeId = themeId || imp.themeId || null;
  const finding = findingsOf(imp).find((f) => f.key === findingKey);
  if (!finding) throw new FixError("NOT_FOUND", "Finding not found in this audit.");
  if (finding.conflict) {
    throw new FixError("UNSUPPORTED_FINDING", "This finding has conflicting entries in the imported file, so it cannot be fixed from this import.");
  }
  const allDefs = fixTypesForAuditId(finding.auditId);
  if (!allDefs.length) {
    throw new FixError("UNSUPPORTED_FIX_TYPE", "This finding has no automatic fix. Follow the manual recommendation.");
  }
  // Changes whose link to the finding cannot be confirmed are only prepared when
  // the merchant explicitly acknowledges that they may not resolve it.
  const defs = allDefs.filter((d) => rootCauseConfirmed(d, finding.auditId) || acknowledgeUnconfirmed);
  if (!defs.length) {
    throw new FixError("ROOT_CAUSE_UNCONFIRMED", `${allDefs[0].rootCauseNote} Confirm that you want to prepare this related improvement anyway.`);
  }
  if (!canModifyStore(imp)) {
    throw new FixError("STORE_NOT_CONFIRMED", "Confirm that this audit belongs to this store before preparing fixes.");
  }

  const shopInfo = await fetchShopInfo(admin);
  const ctx = ctxFor({ admin, db, session, shopName: shopInfo.name });
  const drafts = [];
  const manual = [];
  // Resources the audit named that do not exist in this store (never guessed),
  // and resources whose preparation failed. Other resources still get prepared.
  const unresolved = [];
  const failed = [];
  const isFatal = (err) => !(err instanceof FixError) || err.code === "SESSION_EXPIRED";

  const apiDefs = defs.filter((d) => d.executionKind === "admin_api");
  const themeDefs = defs.filter((d) => d.executionKind === "theme");

  if (apiDefs.length) {
    const urls = finding.affectedUrls.slice(0, MAX_URLS_PER_PREPARE);
    if (finding.affectedUrls.length > MAX_URLS_PER_PREPARE) {
      manual.push({ url: null, reason: `Only the first ${MAX_URLS_PER_PREPARE} of ${finding.affectedUrls.length} affected pages were prepared. Prepare again after reviewing these.` });
    }
    const cache = new Map();
    // One resource at a time: keeps Admin API usage within rate limits.
    for (const url of urls) {
      const c = classifyStoreUrl(url, imp.auditedHost);
      const forKind = apiDefs.filter((d) => d.targetKind === c.kind);
      if (!forKind.length) {
        const kinds = [...new Set(apiDefs.map((d) => `${d.targetKind} pages`))].join(" and ");
        manual.push({ url, reason: c.reason || `Automatic fixes for this finding are only available on ${kinds}. Fix this page manually.` });
        continue;
      }
      const cacheKey = `${c.kind}:${c.handle}`;
      try {
        if (!cache.has(cacheKey)) cache.set(cacheKey, await lookupByHandle(admin, c.kind, c.handle));
      } catch (err) {
        if (isFatal(err)) throw err;
        failed.push({ url, reason: `Could not look up this ${c.kind}: ${err.message}` });
        continue;
      }
      const resource = cache.get(cacheKey);
      if (!resource) {
        unresolved.push({ url, reason: `No ${c.kind} with the handle "${c.handle}" exists in this store, so no change was prepared for it.` });
        continue;
      }
      for (const def of forKind) {
        let out;
        try {
          out = await def.handler.prepare(ctx, { resource, url, finding });
        } catch (err) {
          if (isFatal(err)) throw err;
          if (ROOT_CAUSE_CODES.includes(err.code)) manual.push({ url, reason: `Requires manual review: ${err.message}` });
          else failed.push({ url, reason: `${def.label} could not be prepared: ${err.message}` });
          continue;
        }
        if (!out.length && def.type === "product_image_alt") {
          manual.push({
            url,
            reason: `Every image of "${resource.title}" already has alt text in Shopify Admin. The images the audit flagged on this page are probably theme or app images; set their alt text in the theme editor.`,
          });
        }
        for (const d of out) drafts.push({ def, d });
      }
    }
  }

  if (themeDefs.length) {
    if (!themeId) {
      throw new FixError("THEME_REQUIRED", "Choose the theme to fix at the top of this page first. Only unpublished or development themes can be chosen.");
    }
    for (const def of themeDefs) {
      try {
        for (const d of await def.handler.prepare(ctx, { themeId, finding })) drafts.push({ def, d });
      } catch (err) {
        // The chosen theme is one explicit target: a wrong theme (e.g. the live
        // one) rejects the whole request instead of being counted per resource.
        if (!(err instanceof FixError) || !ROOT_CAUSE_CODES.includes(err.code)) throw err;
        manual.push({ url: null, reason: `Requires manual review: ${err.message}` });
      }
    }
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const { def, d } of drafts) {
    // One change per (import, fix type, resource): different audit findings that
    // point at the same resource (e.g. a11y.image-alt and seo.img.alt-missing)
    // share it, so the merchant never reviews the same field twice.
    const dedupeKey = [imp.id, def.type, d.resourceId].join("|");
    const fields = {
      resourceLabel: cleanLine(d.resourceLabel, 300),
      targetUrl: d.targetUrl,
      beforeJson: JSON.stringify(d.before),
      proposedJson: JSON.stringify(d.proposed),
      approvedJson: null,
      approvedAt: null,
      status: EXEC.NEEDS_REVIEW,
      verificationStatus: VERIFY.NOT_STARTED,
      verificationJson: null,
      errorMessage: null,
      retryable: false,
    };
    const existing = await db.fixExecution.findUnique({
      where: { shop_dedupeKey: { shop: session.shop, dedupeKey } },
    });
    if (!existing) {
      try {
        await db.fixExecution.create({
          data: {
            ...fields,
            shop: session.shop,
            importId: imp.id,
            findingKey: finding.key,
            fixType: def.type,
            executionKind: def.executionKind,
            resourceType: d.resourceType,
            resourceId: d.resourceId,
            parentResourceId: d.parentResourceId ?? null,
            dedupeKey,
          },
        });
        created++;
      } catch (err) {
        // A concurrent prepare created it first; keep that one untouched.
        if (err?.code !== "P2002") throw err;
        unchanged++;
      }
    } else if ([EXEC.NEEDS_REVIEW, EXEC.STALE, EXEC.FAILED, EXEC.SKIPPED].includes(existing.status)) {
      await db.fixExecution.update({ where: { id: existing.id }, data: { ...fields, revision: { increment: 1 } } });
      updated++;
    } else {
      unchanged++; // APPROVED / APPLYING / APPLIED are never silently reset
    }
  }
  return {
    created,
    updated,
    unchanged,
    manual,
    unresolved,
    failed,
    affected: finding.affectedUrls.length,
    prepared: new Set(drafts.map(({ def, d }) => `${def.type}|${d.resourceId}`)).size,
  };
}

// One line for the merchant: how the affected resources of a finding ended up.
export function prepareSummary(r) {
  const parts = [`${r.affected} affected page${r.affected === 1 ? "" : "s"}`, `${r.prepared} change${r.prepared === 1 ? "" : "s"} prepared`];
  if (r.manual?.length) parts.push(`${r.manual.length} need manual review`);
  if (r.unresolved?.length) parts.push(`${r.unresolved.length} not found in the store`);
  if (r.failed?.length) parts.push(`${r.failed.length} failed`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- approve

// Records where an approved value came from. An AI suggestion id is only
// accepted if it is a VALID suggestion for this exact change in this shop. AI
// output never affects whether a change may run; it is recorded for the audit trail.
async function valueSource(db, shop, plan, item, value, proposed, serverValue) {
  if (serverValue) return { record: { type: plan.rollbackOfId ? "restore" : "deterministic_patch" }, warnings: [] };
  if (item.aiSuggestionId !== undefined) {
    const s = isValidId(item.aiSuggestionId)
      ? await db.aiSuggestion.findFirst({
          where: { id: item.aiSuggestionId, shop, executionId: plan.id, kind: "value", status: "VALID" },
        })
      : null;
    if (!s) throw new FixError("REVIEW_OUTDATED", "The AI suggestion you used is not valid for this change. Reload and review it again.");
    const out = safeJsonParse(s.outputJson, {});
    const exact = out.proposedValue === value;
    const warnings = [];
    if (!exact) {
      const unsupported = unsupportedClaimsFor(value, s.validationJson);
      if (unsupported.length) warnings.push(`Your edit adds terms not found in the store's data: ${unsupported.join(", ")}. Check they are accurate.`);
    }
    return {
      record: { type: exact ? "ai" : "ai_edited", suggestionId: s.id, provider: s.provider, model: s.model },
      warnings,
    };
  }
  return { record: { type: value === proposed.value ? "suggested" : "merchant" }, warnings: [] };
}

function unsupportedClaimsFor(value, validationJson) {
  const sourceText = safeJsonParse(validationJson, {})?.sourceText;
  return typeof sourceText === "string" ? unsupportedClaims(value, sourceText) : [];
}

async function markStale(db, plan, current, def) {
  await db.fixExecution.update({
    where: { id: plan.id },
    data: {
      status: EXEC.STALE,
      revision: { increment: 1 },
      beforeJson: JSON.stringify(stripContent(current)),
      approvedJson: null,
      approvedAt: null,
      errorMessage:
        def.executionKind === "theme"
          ? "The theme file changed since the patch was prepared. Nothing was changed. Prepare the fix again."
          : "This value changed in Shopify since it was reviewed. Nothing was changed. Check the refreshed current value and approve again.",
    },
  });
}

export async function approvePlans({ db, admin, session, importId, items, env = process.env }) {
  const imp = await requireImport(db, session.shop, importId);
  const ctx = ctxFor({ admin, db, session });
  const results = [];
  for (const item of (items || []).slice(0, 100)) {
    const plan = isValidId(item?.planId)
      ? await db.fixExecution.findFirst({ where: { id: item.planId, shop: session.shop, importId: imp.id } })
      : null;
    if (!plan) {
      results.push({ planId: item?.planId ?? null, ok: false, message: "Change not found." });
      continue;
    }
    try {
      if (![EXEC.NEEDS_REVIEW, EXEC.STALE].includes(plan.status)) {
        throw new FixError("INVALID_STATE", `A change that is "${EXEC_LABELS[plan.status]}" cannot be approved.`);
      }
      const def = getFixType(plan.fixType);
      if ((def.executionKind === "theme" || plan.rollbackOfId) && plan.status === EXEC.STALE) {
        throw new FixError(
          "REPREPARE_REQUIRED",
          plan.rollbackOfId
            ? "The resource changed since this restore was prepared. Prepare the rollback again from Execution history."
            : "The theme file changed. Prepare the fix again before approving.",
        );
      }
      const problems = eligibilityProblems(def, { session, importRecord: imp, env });
      if (problems.length) throw new FixError("NOT_ELIGIBLE", problems.join(" "));

      // The approval binds the exact revision the merchant reviewed. Any later
      // refresh, stale check, edit or state change increments it.
      if (item.seenRevision !== plan.revision) {
        throw new FixError("REVIEW_OUTDATED", "This change was updated after you reviewed it. Reload and review it again.");
      }
      // The approval must match what the merchant actually reviewed: the
      // before-value shown for text changes, and the exact patch for theme
      // changes and restores (whose value is server-generated, never typed).
      const stored = safeJsonParse(plan.beforeJson, {});
      const proposed = safeJsonParse(plan.proposedJson, {});
      const serverValue = def.executionKind === "theme" || plan.rollbackOfId;
      if (serverValue) {
        if (item.seenProposed !== proposed.value) {
          throw new FixError("REVIEW_OUTDATED", "This change was updated after you reviewed it. Reload and review it again.");
        }
      } else if (item.seenBefore === undefined || normValue(item.seenBefore) !== normValue(def.handler.beforeValue(stored))) {
        throw new FixError("REVIEW_OUTDATED", "The current value you reviewed is out of date. Reload and review it again.");
      }

      const current = await def.handler.fetchCurrent(ctx, plan);
      if (def.handler.isStale(stored, current)) {
        await markStale(db, plan, current, def);
        results.push({ planId: plan.id, ok: false, stale: true, message: "Changed in Shopify since review. The current value was refreshed; review it again." });
        continue;
      }
      const value = serverValue ? proposed.value : item.value;
      const v = validateFor(def, plan, value, current);
      if (!v.ok) throw new FixError("INVALID_VALUE", v.errors.join(" "));

      const source = await valueSource(db, session.shop, plan, item, v.value, proposed, serverValue);
      const revision = plan.revision + 1;
      const hash = approvalHash(plan, session.shop, v.value, def.handler.beforeValue(current), revision);
      const claim = await db.fixExecution.updateMany({
        where: { id: plan.id, shop: session.shop, status: plan.status, revision: plan.revision },
        data: {
          status: EXEC.APPROVED,
          revision,
          approvedAt: new Date(),
          approvedJson: JSON.stringify({
            before: stripContent(current),
            value: v.value,
            warnings: [...v.warnings, ...source.warnings],
            hash,
            revision,
            source: source.record,
          }),
          proposedJson: JSON.stringify({ ...proposed, value: v.value }),
          beforeJson: JSON.stringify(stripContent(current)),
          errorMessage: null,
        },
      });
      if (claim.count !== 1) throw new FixError("INVALID_STATE", "This change was modified by another request.");
      results.push({ planId: plan.id, ok: true, warnings: [...v.warnings, ...source.warnings] });
    } catch (err) {
      if (err instanceof FixError) {
        results.push({ planId: plan.id, ok: false, code: err.code, message: err.message });
        if (err.code === "SESSION_EXPIRED") break;
      } else throw err;
    }
  }
  return results;
}

export async function unapprovePlan({ db, session, planId }) {
  const r = await db.fixExecution.updateMany({
    where: { id: planId, shop: session.shop, status: EXEC.APPROVED },
    data: { status: EXEC.NEEDS_REVIEW, approvedJson: null, approvedAt: null, revision: { increment: 1 } },
  });
  if (r.count !== 1) throw new FixError("INVALID_STATE", "Only approved changes can be returned to review.");
}

// The merchant decides a change needs manual handling. It can no longer be
// approved or executed until it is returned to review (Retry in history).
export async function markManualReview({ db, session, planId, note }) {
  const r = await db.fixExecution.updateMany({
    where: { id: planId, shop: session.shop, status: { in: [EXEC.NEEDS_REVIEW, EXEC.STALE, EXEC.APPROVED] } },
    data: {
      status: EXEC.MANUAL_REVIEW,
      revision: { increment: 1 },
      approvedJson: null,
      approvedAt: null,
      errorMessage: `Marked for manual review by the merchant${note ? `: ${cleanLine(note, 300)}` : "."}`,
    },
  });
  if (r.count !== 1) throw new FixError("INVALID_STATE", "This change cannot be marked for manual review in its current state.");
}

export async function skipPlan({ db, session, planId }) {
  const r = await db.fixExecution.updateMany({
    where: {
      id: planId,
      shop: session.shop,
      status: { in: [EXEC.NEEDS_REVIEW, EXEC.STALE, EXEC.APPROVED, EXEC.FAILED] },
    },
    data: { status: EXEC.SKIPPED, approvedJson: null, approvedAt: null, revision: { increment: 1 } },
  });
  if (r.count !== 1) throw new FixError("INVALID_STATE", "This change cannot be skipped in its current state.");
}

// ---------------------------------------------------------------- execute

async function executeOne({ db, admin, session, imp, plan, env, sleep, jobPolls }) {
  const ctx = ctxFor({ admin, db, session, sleep, jobPolls });
  let phase = "prepare";
  try {
    const def = getFixType(plan.fixType);
    const approved = safeJsonParse(plan.approvedJson);
    if (!approved || typeof approved.value !== "string" || !approved.before) {
      throw new FixError("NOT_APPROVED", "This change has no valid approval.");
    }
    // The approval must still describe exactly this shop/finding/resource/fix/value/before-state.
    if (
      approved.revision !== plan.revision ||
      approved.hash !== approvalHash(plan, session.shop, approved.value, def.handler.beforeValue(approved.before), approved.revision)
    ) {
      throw new FixError("APPROVAL_MISMATCH", "The approval does not match this change any more. Nothing was sent; review it again.");
    }
    const problems = eligibilityProblems(def, { session, importRecord: imp, env });
    if (problems.length) throw new FixError("NOT_ELIGIBLE", problems.join(" "));

    const current = await def.handler.fetchCurrent(ctx, plan);
    const snapshot = stripContent(current);
    if (def.handler.isStale(approved.before, current)) {
      if (def.handler.alreadyApplied(current, approved.value)) {
        // Someone (or an earlier interrupted run) already saved exactly this value.
        await db.fixExecution.update({
          where: { id: plan.id },
          data: {
            status: EXEC.APPLIED,
            appliedAt: new Date(),
            resultJson: JSON.stringify({ mutation: null, note: "Value already present; no change sent." }),
            verificationStatus: VERIFY.PASSED,
            verificationJson: JSON.stringify({ message: "The resource already had the approved value. No change was sent." }),
            verifiedAt: new Date(),
          },
        });
        return { planId: plan.id, ok: true, status: EXEC.APPLIED, verificationStatus: VERIFY.PASSED, message: "Already had the approved value; nothing was sent." };
      }
      await markStale(db, plan, current, def);
      return { planId: plan.id, ok: false, status: EXEC.STALE, message: "Changed in Shopify since approval. Nothing was changed; review it again." };
    }

    // Policy is re-checked at execution time, not trusted from the approval.
    const v = validateFor(def, plan, approved.value, current);
    if (!v.ok) throw new FixError("INVALID_VALUE", v.errors.join(" "));

    phase = "apply";
    const applyResult = await def.handler.apply(ctx, plan, v.value, current);
    phase = "record";
    await db.fixExecution.update({
      where: { id: plan.id },
      data: {
        status: EXEC.APPLIED,
        appliedAt: new Date(),
        resultJson: JSON.stringify(applyResult),
        verificationStatus: VERIFY.PENDING,
        errorMessage: null,
      },
    });

    phase = "verify";
    let verification;
    try {
      verification = await def.handler.verify(ctx, plan, v.value, snapshot, applyResult);
    } catch (err) {
      if (!(err instanceof FixError)) throw err;
      verification = { status: VERIFY.UNAVAILABLE, message: `The change was sent but could not be verified: ${err.message}` };
    }
    await db.fixExecution.update({
      where: { id: plan.id },
      data: {
        verificationStatus: verification.status,
        verificationJson: JSON.stringify({ message: verification.message, details: verification.details ?? null }),
        verifiedAt: new Date(),
      },
    });
    return { planId: plan.id, ok: true, status: EXEC.APPLIED, verificationStatus: verification.status, message: verification.message };
  } catch (err) {
    const fe =
      err instanceof FixError
        ? err
        : new FixError("UNEXPECTED", "Unexpected error while applying this change.", { retryable: true });
    if (!(err instanceof FixError)) {
      console.error(`[fixes] unexpected error for change ${plan.id} during ${phase}: ${err?.message}`);
    }
    let message = fe.message;
    if (phase === "apply" && fe.retryable) {
      message += " The change may or may not have been saved. Retry reads the current value again before anything is sent.";
    }
    if (phase === "record" || phase === "verify") {
      message = `The change was sent to Shopify, but recording the result failed: ${fe.message}`;
    }
    await db.fixExecution.update({
      where: { id: plan.id },
      data: { status: EXEC.FAILED, errorMessage: message, retryable: fe.retryable },
    });
    return { planId: plan.id, ok: false, status: EXEC.FAILED, code: fe.code, message };
  }
}

export async function executePlans({ db, admin, session, importId, planIds, expectedBatchToken, env = process.env, sleep, jobPolls }) {
  const imp = await requireImport(db, session.shop, importId);
  const ids = [...new Set((planIds || []).filter(isValidId))].slice(0, 50);
  if (expectedBatchToken !== undefined) {
    // The merchant confirmed one exact batch. If any change in it is no longer
    // approved, or was re-approved with different values, refuse the whole batch.
    const rows = await db.fixExecution.findMany({
      where: { id: { in: ids }, shop: session.shop, importId: imp.id, status: EXEC.APPROVED },
    });
    if (rows.length !== ids.length || batchToken(rows) !== expectedBatchToken) {
      throw new FixError("BATCH_CHANGED", "The set of approved changes changed since you confirmed it. Nothing was applied. Review the list again.");
    }
  }
  const results = [];
  let sessionExpired = false;
  for (const id of ids) {
    if (sessionExpired) {
      results.push({ planId: id, ok: false, message: "Not attempted because the session expired. It is still approved." });
      continue;
    }
    // Atomic claim: only an APPROVED change of this shop/import can move to
    // APPLYING, so double submits and concurrent requests cannot run it twice.
    const claim = await db.fixExecution.updateMany({
      where: { id, shop: session.shop, importId: imp.id, status: EXEC.APPROVED },
      data: { status: EXEC.APPLYING, attempts: { increment: 1 }, errorMessage: null },
    });
    if (claim.count !== 1) {
      results.push({ planId: id, ok: false, message: "Not executed: it is not approved, or it is already running or applied." });
      continue;
    }
    const plan = await db.fixExecution.findFirst({ where: { id, shop: session.shop } });
    const r = await executeOne({ db, admin, session, imp, plan, env, sleep, jobPolls });
    results.push(r);
    if (r.code === "SESSION_EXPIRED") sessionExpired = true;
  }
  return { results, sessionExpired };
}

// ---------------------------------------------------------------- after execution

export async function retryPlan({ db, admin, session, planId }) {
  const plan = isValidId(planId)
    ? await db.fixExecution.findFirst({ where: { id: planId, shop: session.shop } })
    : null;
  if (!plan) throw new FixError("NOT_FOUND", "Change not found.");
  const stuck = plan.status === EXEC.APPLYING && Date.now() - new Date(plan.updatedAt).getTime() > STUCK_APPLYING_MS;
  const verifyFailed =
    plan.status === EXEC.APPLIED && [VERIFY.FAILED, VERIFY.UNAVAILABLE].includes(plan.verificationStatus);
  if (!(plan.status === EXEC.FAILED || plan.status === EXEC.STALE || plan.status === EXEC.MANUAL_REVIEW || verifyFailed || stuck)) {
    throw new FixError("INVALID_STATE", "Only failed, conflicting, manual-review or unverified changes can be returned to review.");
  }
  if (plan.rollbackOfId) {
    throw new FixError("INVALID_STATE", "A restore cannot be retried directly. Prepare the rollback again from the original change, so its conflict checks run again.");
  }
  const def = getFixType(plan.fixType);
  const ctx = ctxFor({ admin, db, session });
  const data = {
    status: EXEC.NEEDS_REVIEW,
    verificationStatus: VERIFY.NOT_STARTED,
    verificationJson: null,
    approvedJson: null,
    approvedAt: null,
    errorMessage: null,
    retryable: false,
    revision: { increment: 1 },
  };
  if (def.executionKind === "theme") {
    // Recompute the patch from the theme's current file; this refuses if the
    // fix is already present or the anchor is no longer unambiguous.
    const [draft] = await def.handler.prepare(ctx, { themeId: plan.resourceId });
    data.beforeJson = JSON.stringify(draft.before);
    data.proposedJson = JSON.stringify(draft.proposed);
  } else {
    const current = await def.handler.fetchCurrent(ctx, plan);
    // Reconcile an interrupted or ambiguous write before anything else: if the
    // approved value is already saved, record that (verified by read-back)
    // instead of asking the merchant to send it again.
    const approved = safeJsonParse(plan.approvedJson);
    if ((plan.status === EXEC.FAILED || stuck) && typeof approved?.value === "string" && def.handler.alreadyApplied(current, approved.value)) {
      const r = await db.fixExecution.updateMany({
        where: { id: plan.id, shop: session.shop, status: plan.status },
        data: {
          status: EXEC.APPLIED,
          appliedAt: new Date(),
          errorMessage: null,
          retryable: false,
          resultJson: JSON.stringify({ mutation: null, reconciled: true, note: "Reconciled after an interrupted attempt: Shopify already has the approved value." }),
          verificationStatus: VERIFY.PASSED,
          verificationJson: JSON.stringify({ message: "Read back from Shopify during reconciliation: the saved value matches the approved value.", details: { after: stripContent(current) } }),
          verifiedAt: new Date(),
        },
      });
      if (r.count !== 1) throw new FixError("INVALID_STATE", "This change was modified by another request.");
      return { importId: plan.importId, reconciled: true };
    }
    data.beforeJson = JSON.stringify(stripContent(current));
  }
  // A retry never re-sends anything: it returns the change to review with the
  // freshly read current state, and the merchant must approve and confirm again.
  const r = await db.fixExecution.updateMany({
    where: { id: plan.id, shop: session.shop, status: plan.status },
    data,
  });
  if (r.count !== 1) throw new FixError("INVALID_STATE", "This change was modified by another request.");
  return { importId: plan.importId, reconciled: false };
}

export async function reverifyPlan({ db, admin, session, planId, sleep }) {
  const plan = isValidId(planId)
    ? await db.fixExecution.findFirst({ where: { id: planId, shop: session.shop } })
    : null;
  if (!plan) throw new FixError("NOT_FOUND", "Change not found.");
  if (plan.status !== EXEC.APPLIED || plan.verificationStatus === VERIFY.PASSED) {
    throw new FixError("INVALID_STATE", "Only applied changes that are not yet verified can be re-verified.");
  }
  const def = getFixType(plan.fixType);
  const approved = safeJsonParse(plan.approvedJson, {});
  const ctx = ctxFor({ admin, db, session, sleep });
  const verification = await def.handler.verify(ctx, plan, approved.value, approved.before, null);
  await db.fixExecution.update({
    where: { id: plan.id },
    data: {
      verificationStatus: verification.status,
      verificationJson: JSON.stringify({ message: verification.message, details: verification.details ?? null }),
      verifiedAt: new Date(),
    },
  });
  return verification;
}

// ---------------------------------------------------------------- rollback

const ACTIVE_ROLLBACK = [EXEC.NEEDS_REVIEW, EXEC.APPROVED, EXEC.APPLYING, EXEC.APPLIED];

// What can honestly be said about undoing an applied change. Shown in history.
export function reversibility(plan, { hasBackup = false } = {}) {
  if (plan.status !== EXEC.APPLIED) return null;
  if (plan.rollbackOfId) return { reversible: false, reason: "This change is itself a restore." };
  const approved = safeJsonParse(plan.approvedJson, {});
  if (plan.executionKind === "theme") {
    return hasBackup
      ? { reversible: true, reason: "The original file was backed up. It can be restored while the theme is unpublished and the file is unchanged since this app wrote it." }
      : { reversible: false, reason: "No backup was recorded for this change, so it cannot be restored automatically." };
  }
  const def = fixTypeOrNull(plan.fixType);
  const previous = def ? def.handler.beforeValue(approved.before) : null;
  if (!normValue(previous)) {
    return {
      reversible: false,
      reason: "The field was empty before this change. Clearing a field through the API has not been verified for this app, so clear it manually in Shopify Admin if needed.",
    };
  }
  return { reversible: true, reason: "The previous value was recorded. It can be restored only if nobody has changed the field since this app wrote it." };
}

function fixTypeOrNull(type) {
  try {
    return getFixType(type);
  } catch {
    return null;
  }
}

// Prepares a restore as a new, reviewable change. It never writes by itself: the
// merchant approves and confirms it like any other change, with the same stale,
// approval-fingerprint and verification checks.
export async function prepareRollback({ db, admin, session, planId }) {
  const plan = isValidId(planId)
    ? await db.fixExecution.findFirst({ where: { id: planId, shop: session.shop } })
    : null;
  if (!plan) throw new FixError("NOT_FOUND", "Change not found.");
  if (plan.status !== EXEC.APPLIED) throw new FixError("INVALID_STATE", "Only applied changes can be rolled back.");
  if (plan.rollbackOfId) throw new FixError("INVALID_STATE", "This change is itself a restore and cannot be rolled back again.");
  const active = await db.fixExecution.findFirst({
    where: { shop: session.shop, rollbackOfId: plan.id, status: { in: ACTIVE_ROLLBACK } },
  });
  if (active) throw new FixError("INVALID_STATE", "A rollback for this change already exists. See the review page.");
  const imp = await requireImport(db, session.shop, plan.importId);
  if (!canModifyStore(imp)) throw new FixError("STORE_NOT_CONFIRMED", "This audit is not confirmed for this store.");

  const def = getFixType(plan.fixType);
  const approved = safeJsonParse(plan.approvedJson, {});
  const ctx = ctxFor({ admin, db, session });
  let draft;
  if (def.executionKind === "theme") {
    draft = await def.handler.prepareRestore(ctx, plan, approved);
  } else {
    const previous = def.handler.beforeValue(approved.before);
    if (!normValue(previous)) {
      throw new FixError("ROLLBACK_UNSUPPORTED", reversibility(plan).reason);
    }
    const current = await def.handler.fetchCurrent(ctx, plan);
    if (normValue(def.handler.beforeValue(current)) !== approved.value) {
      throw new FixError(
        "ROLLBACK_CONFLICT",
        "This field has changed since this app wrote it (by the merchant, another app or Shopify). Restoring the old value would overwrite that newer change, so review it manually.",
      );
    }
    draft = {
      resourceType: plan.resourceType,
      resourceId: plan.resourceId,
      parentResourceId: plan.parentResourceId,
      resourceLabel: `${plan.resourceLabel} (restore)`,
      targetUrl: plan.targetUrl,
      before: stripContent(current),
      proposed: {
        value: previous,
        note: `Restores the value recorded before the change applied on ${new Date(plan.appliedAt).toISOString().slice(0, 10)}.`,
      },
    };
  }
  const row = await db.fixExecution.create({
    data: {
      shop: session.shop,
      importId: plan.importId,
      findingKey: plan.findingKey,
      fixType: plan.fixType,
      executionKind: plan.executionKind,
      resourceType: draft.resourceType,
      resourceId: draft.resourceId,
      parentResourceId: draft.parentResourceId ?? null,
      resourceLabel: cleanLine(draft.resourceLabel, 300),
      targetUrl: draft.targetUrl,
      dedupeKey: `rollback|${plan.id}|${Date.now()}`,
      rollbackOfId: plan.id,
      beforeJson: JSON.stringify(draft.before),
      proposedJson: JSON.stringify(draft.proposed),
      status: EXEC.NEEDS_REVIEW,
      verificationStatus: VERIFY.NOT_STARTED,
    },
  });
  return { planId: row.id, importId: plan.importId };
}

// Shapes a FixExecution for the UI. Contains no secrets and no theme file content.
export function serializePlan(p) {
  return {
    id: p.id,
    importId: p.importId,
    findingKey: p.findingKey,
    fixType: p.fixType,
    executionKind: p.executionKind,
    resourceType: p.resourceType,
    resourceId: p.resourceId,
    resourceLabel: p.resourceLabel,
    targetUrl: p.targetUrl,
    rollbackOfId: p.rollbackOfId ?? null,
    revision: p.revision,
    state: proposalState(p.status, p.verificationStatus),
    before: safeJsonParse(p.beforeJson, {}),
    proposed: safeJsonParse(p.proposedJson, {}),
    approved: safeJsonParse(p.approvedJson),
    result: safeJsonParse(p.resultJson),
    status: p.status,
    verificationStatus: p.verificationStatus,
    verification: safeJsonParse(p.verificationJson),
    liveCheck: safeJsonParse(p.liveCheckJson),
    errorMessage: p.errorMessage,
    retryable: p.retryable,
    attempts: p.attempts,
    approvedAt: p.approvedAt,
    appliedAt: p.appliedAt,
    verifiedAt: p.verifiedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
