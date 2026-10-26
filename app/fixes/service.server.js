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
import { EXEC, EXEC_LABELS, VERIFY } from "./constants";
import { FixError } from "./graphql.server";
import { parseAuditFile } from "./importer.server";
import {
  eligibilityProblems,
  fixTypesForAuditId,
  getFixType,
} from "./registry.server";
import { classifyStoreUrl, lookupByHandle } from "./resolve.server";
import {
  canModifyStore,
  evaluateStoreMatch,
  fetchShopInfo,
  validateStoreConfirmation,
} from "./storeMatch.server";
import { cleanLine, safeJsonParse } from "./text";

const ID_RE = /^[a-z0-9]{10,40}$/i;
const MAX_URLS_PER_PREPARE = 25;
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

// Binds an approval to exactly one shop, finding, resource, fix type, value and
// before-state. Recomputed at execution; any difference voids the approval.
// Keyed with the app secret when available so it cannot be recomputed from data alone.
export function approvalHash(plan, shop, value, beforeValue) {
  const payload = JSON.stringify([
    shop,
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

export async function createImport({ db, admin, session, text, fileName }) {
  const parsed = parseAuditFile(text);
  const shopInfo = await fetchShopInfo(admin);
  const match = evaluateStoreMatch(parsed.auditedHost, session.shop, shopInfo);
  return db.auditImport.create({
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
    },
  });
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
  const finding = findingsOf(imp).find((f) => f.key === findingKey);
  if (!finding) throw new FixError("NOT_FOUND", "Finding not found in this audit.");
  const allDefs = fixTypesForAuditId(finding.auditId);
  if (!allDefs.length) {
    throw new FixError("UNSUPPORTED_FIX_TYPE", "This finding has no automatic fix. Follow the manual recommendation.");
  }
  // Changes whose link to the finding cannot be confirmed are only prepared when
  // the merchant explicitly acknowledges that they may not resolve it.
  const defs = allDefs.filter((d) => d.rootCause !== "unconfirmed" || acknowledgeUnconfirmed);
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

  const apiDefs = defs.filter((d) => d.executionKind === "admin_api");
  const themeDefs = defs.filter((d) => d.executionKind === "theme");

  if (apiDefs.length) {
    const urls = finding.affectedUrls.slice(0, MAX_URLS_PER_PREPARE);
    if (finding.affectedUrls.length > MAX_URLS_PER_PREPARE) {
      manual.push({ url: null, reason: `Only the first ${MAX_URLS_PER_PREPARE} affected pages were prepared.` });
    }
    const cache = new Map();
    for (const url of urls) {
      const c = classifyStoreUrl(url, imp.auditedHost);
      const forKind = apiDefs.filter((d) => d.targetKind === c.kind);
      if (!forKind.length) {
        const kinds = [...new Set(apiDefs.map((d) => `${d.targetKind} pages`))].join(" and ");
        manual.push({ url, reason: c.reason || `Automatic fixes for this finding are only available on ${kinds}. Fix this page manually.` });
        continue;
      }
      const cacheKey = `${c.kind}:${c.handle}`;
      if (!cache.has(cacheKey)) cache.set(cacheKey, await lookupByHandle(admin, c.kind, c.handle));
      const resource = cache.get(cacheKey);
      if (!resource) {
        manual.push({ url, reason: `No ${c.kind} with the handle "${c.handle}" exists in this store.` });
        continue;
      }
      for (const def of forKind) {
        let out;
        try {
          out = await def.handler.prepare(ctx, { resource, url, finding });
        } catch (err) {
          if (!(err instanceof FixError) || !ROOT_CAUSE_CODES.includes(err.code)) throw err;
          manual.push({ url, reason: `Requires manual review: ${err.message}` });
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
      throw new FixError("THEME_REQUIRED", "Choose an unpublished or development theme to prepare this fix.");
    }
    for (const def of themeDefs) {
      try {
        for (const d of await def.handler.prepare(ctx, { themeId, finding })) drafts.push({ def, d });
      } catch (err) {
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
      await db.fixExecution.update({ where: { id: existing.id }, data: fields });
      updated++;
    } else {
      unchanged++; // APPROVED / APPLYING / APPLIED are never silently reset
    }
  }
  return { created, updated, unchanged, manual };
}

// ---------------------------------------------------------------- approve

async function markStale(db, plan, current, def) {
  await db.fixExecution.update({
    where: { id: plan.id },
    data: {
      status: EXEC.STALE,
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

      const hash = approvalHash(plan, session.shop, v.value, def.handler.beforeValue(current));
      const claim = await db.fixExecution.updateMany({
        where: { id: plan.id, shop: session.shop, status: plan.status },
        data: {
          status: EXEC.APPROVED,
          approvedAt: new Date(),
          approvedJson: JSON.stringify({ before: stripContent(current), value: v.value, warnings: v.warnings, hash }),
          proposedJson: JSON.stringify({ ...proposed, value: v.value }),
          beforeJson: JSON.stringify(stripContent(current)),
          errorMessage: null,
        },
      });
      if (claim.count !== 1) throw new FixError("INVALID_STATE", "This change was modified by another request.");
      results.push({ planId: plan.id, ok: true, warnings: v.warnings });
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
    data: { status: EXEC.NEEDS_REVIEW, approvedJson: null, approvedAt: null },
  });
  if (r.count !== 1) throw new FixError("INVALID_STATE", "Only approved changes can be returned to review.");
}

export async function skipPlan({ db, session, planId }) {
  const r = await db.fixExecution.updateMany({
    where: {
      id: planId,
      shop: session.shop,
      status: { in: [EXEC.NEEDS_REVIEW, EXEC.STALE, EXEC.APPROVED, EXEC.FAILED] },
    },
    data: { status: EXEC.SKIPPED, approvedJson: null, approvedAt: null },
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
    if (approved.hash !== approvalHash(plan, session.shop, approved.value, def.handler.beforeValue(approved.before))) {
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
  if (!(plan.status === EXEC.FAILED || plan.status === EXEC.STALE || verifyFailed || stuck)) {
    throw new FixError("INVALID_STATE", "Only failed, changed or unverified changes can be retried.");
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
  };
  if (def.executionKind === "theme") {
    // Recompute the patch from the theme's current file; this refuses if the
    // fix is already present or the anchor is no longer unambiguous.
    const [draft] = await def.handler.prepare(ctx, { themeId: plan.resourceId });
    data.beforeJson = JSON.stringify(draft.before);
    data.proposedJson = JSON.stringify(draft.proposed);
  } else {
    const current = await def.handler.fetchCurrent(ctx, plan);
    data.beforeJson = JSON.stringify(stripContent(current));
  }
  // A retry never re-sends anything: it returns the change to review with the
  // freshly read current state, and the merchant must approve and confirm again.
  const r = await db.fixExecution.updateMany({
    where: { id: plan.id, shop: session.shop, status: plan.status },
    data,
  });
  if (r.count !== 1) throw new FixError("INVALID_STATE", "This change was modified by another request.");
  return plan.importId;
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
