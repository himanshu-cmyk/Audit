// AI suggestions and analyses. Advisory only: nothing here writes to Shopify. A
// VALID suggestion can be copied by the merchant into a change, which still goes
// through review, approval, re-validation, execution and verification.

import { EXEC } from "../fixes/constants";
import { FixError } from "../fixes/graphql.server";
import { classifyFinding, getFixType, manualReason } from "../fixes/registry.server";
import { findingsOf, isValidId, loadImport } from "../fixes/service.server";
import { sourceLimitations } from "../fixes/reportContract.server";
import { safeJsonParse } from "../fixes/text";
import { readAiConfig } from "./config.server";
import { AiError } from "./errors.server";
import { PROMPT_VERSION, SYSTEM_INSTRUCTION, analysisPrompt, valuePrompt } from "./prompts.server";
import { PROPOSAL_RESPONSE_SCHEMA, validateAiProposal } from "./schema.server";

const FIELD_BY_TYPE = {
  product_seo_title: "seoTitle",
  collection_seo_title: "seoTitle",
  product_seo_description: "seoDescription",
  collection_seo_description: "seoDescription",
  product_image_alt: "alt",
};

async function enforceRateLimit(db, shop, env) {
  const { perShopPerMinute } = readAiConfig(env);
  const recent = await db.aiSuggestion.count({ where: { shop, createdAt: { gt: new Date(Date.now() - 60000) } } });
  if (recent >= perShopPerMinute) {
    throw new FixError("AI_RATE_LIMITED", "Too many AI requests in the last minute. Wait a moment and try again.");
  }
}

// In-process concurrency guard: one AI request per shop at a time, and a small
// global cap. Requests over the limit are refused, not queued.
const inFlight = new Map();
let inFlightTotal = 0;

async function withConcurrencyLimit(shop, env, fn) {
  const { maxConcurrent } = readAiConfig(env);
  if (inFlight.get(shop) || inFlightTotal >= maxConcurrent) {
    throw new FixError("AI_BUSY", "Another AI request is still running. Try again when it finishes.");
  }
  inFlight.set(shop, true);
  inFlightTotal++;
  try {
    return await fn();
  } finally {
    inFlight.delete(shop);
    inFlightTotal--;
  }
}

async function callAndStore({ db, provider, record, prompt, validate }) {
  let status;
  let output = null;
  let validation = null;
  let errorCode = null;
  let errorMessage = null;
  try {
    const raw = await provider.generateJson({ system: SYSTEM_INSTRUCTION, prompt, schema: PROPOSAL_RESPONSE_SCHEMA });
    const v = validate(raw);
    status = v.ok ? "VALID" : "INVALID";
    output = v.proposal;
    validation = { errors: v.errors, sourceText: v.sourceText ?? null };
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    status = "ERROR";
    errorCode = err.code;
    errorMessage = err.message;
  }
  const row = await db.aiSuggestion.create({
    data: {
      ...record,
      provider: provider.name,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
      status,
      outputJson: output ? JSON.stringify(output) : null,
      validationJson: validation ? JSON.stringify(validation) : null,
      errorCode,
      errorMessage,
    },
  });
  return serializeSuggestion(row);
}

/** Drafts a value for one Admin text change (SEO title/description, alt text). */
export async function suggestForPlan({ db, admin, session, planId, provider, env = process.env }) {
  const plan = isValidId(planId) ? await db.fixExecution.findFirst({ where: { id: planId, shop: session.shop } }) : null;
  if (!plan) throw new FixError("NOT_FOUND", "Change not found.");
  if (![EXEC.NEEDS_REVIEW, EXEC.STALE].includes(plan.status)) {
    throw new FixError("INVALID_STATE", "AI suggestions are only available for changes awaiting approval.");
  }
  const fieldKey = FIELD_BY_TYPE[plan.fixType];
  if (!fieldKey || plan.executionKind !== "admin_api" || plan.rollbackOfId) {
    throw new FixError("UNSUPPORTED_FIX_TYPE", "AI suggestions are available for SEO and alt-text changes only. Theme patches and restores are deterministic.");
  }
  const imp = await loadImport(db, session.shop, plan.importId);
  const finding = imp && findingsOf(imp).find((f) => f.key === plan.findingKey);
  if (!finding) throw new FixError("NOT_FOUND", "Finding not found.");
  await enforceRateLimit(db, session.shop, env);

  const def = getFixType(plan.fixType);
  // Re-reads the resource through the authenticated shop: proves it still
  // belongs to this shop and gives the AI the real current value.
  const current = await def.handler.fetchCurrent({ admin, db, shop: session.shop }, plan);
  const rules = def.handler.field;
  const { prompt, sourceText, evidenceIds } = valuePrompt({ finding, plan, fieldKey, rules, current });
  const currentValue = def.handler.beforeValue(current);

  return withConcurrencyLimit(session.shop, env, () =>
    callAndStore({
      db,
      provider,
      prompt,
      record: { shop: session.shop, importId: plan.importId, findingKey: plan.findingKey, executionId: plan.id, kind: "value" },
      validate: (raw) => ({
        ...validateAiProposal(raw, {
          findingId: finding.key,
          category: finding.category,
          kind: "value",
          evidenceIds,
          expectedResourceType: plan.resourceType,
          fieldRules: rules,
          currentValue,
          sourceText,
        }),
        sourceText,
      }),
    }),
  );
}

/** Explains a finding. Never proposes an executable value. */
export async function analyzeFinding({ db, session, importId, findingKey, provider, env = process.env }) {
  const imp = await loadImport(db, session.shop, importId);
  if (!imp) throw new FixError("NOT_FOUND", "Audit import not found.");
  const finding = findingsOf(imp).find((f) => f.key === findingKey);
  if (!finding) throw new FixError("NOT_FOUND", "Finding not found.");
  await enforceRateLimit(db, session.shop, env);
  const c = classifyFinding(finding);
  const automation = {
    canFixAutomatically: c.status === "auto",
    actionClass: c.actionClass,
    explanation: c.status === "auto" ? "The app can check the cause in the store and propose a change for merchant approval." : c.reason || manualReason(finding),
  };
  const { prompt, evidenceIds } = analysisPrompt({ finding, automation, limitations: sourceLimitations(finding.auditId, finding.origin ?? null) });
  return withConcurrencyLimit(session.shop, env, () =>
    callAndStore({
      db,
      provider,
      prompt,
      record: { shop: session.shop, importId: imp.id, findingKey: finding.key, executionId: null, kind: "analysis" },
      validate: (raw) => validateAiProposal(raw, { findingId: finding.key, category: finding.category, kind: "analysis", evidenceIds }),
    }),
  );
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * AI help for a whole audit, one request at a time: first drafts values for
 * prepared SEO / alt-text changes that have no valid suggestion yet, then (if
 * `explain`) explains findings that have no analysis yet, most severe first.
 * Stops at the per-minute limit or on a quota error and reports what is left.
 * Advisory only: nothing is approved or sent to Shopify.
 */
export async function aiAssistImport({ db, admin, session, importId, provider, env = process.env, explain = true }) {
  const imp = await loadImport(db, session.shop, importId);
  if (!imp) throw new FixError("NOT_FOUND", "Audit import not found.");
  const plans = await db.fixExecution.findMany({
    where: { shop: session.shop, importId: imp.id, status: { in: [EXEC.NEEDS_REVIEW, EXEC.STALE] }, rollbackOfId: null, executionKind: "admin_api" },
    orderBy: { createdAt: "asc" },
  });
  const haveValue = new Set(
    (await db.aiSuggestion.findMany({ where: { shop: session.shop, importId: imp.id, kind: "value", status: "VALID" }, select: { executionId: true } })).map((s) => s.executionId),
  );
  const haveAnalysis = new Set(
    (await db.aiSuggestion.findMany({ where: { shop: session.shop, importId: imp.id, kind: "analysis", status: "VALID" }, select: { findingKey: true } })).map((s) => s.findingKey),
  );
  const jobs = [
    ...plans.filter((p) => FIELD_BY_TYPE[p.fixType] && !haveValue.has(p.id)).map((p) => ({ kind: "value", run: () => suggestForPlan({ db, admin, session, planId: p.id, provider, env }) })),
    ...(explain
      ? findingsOf(imp)
          .filter((f) => !haveAnalysis.has(f.key))
          .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
          .map((f) => ({ kind: "analysis", run: () => analyzeFinding({ db, session, importId: imp.id, findingKey: f.key, provider, env }) }))
      : []),
  ];
  const out = { values: 0, analyses: 0, invalid: 0, failed: 0, remaining: 0, stopped: null };
  for (let i = 0; i < jobs.length; i++) {
    let s;
    try {
      s = await jobs[i].run();
    } catch (err) {
      if (!(err instanceof FixError) || !["AI_RATE_LIMITED", "AI_BUSY"].includes(err.code)) throw err;
      out.remaining = jobs.length - i;
      out.stopped = err.message;
      break;
    }
    if (s.status === "VALID") out[jobs[i].kind === "value" ? "values" : "analyses"]++;
    else if (s.status === "INVALID") out.invalid++;
    else {
      out.failed++;
      // Quota and authentication problems will not go away within this request.
      if (["AI_QUOTA", "AI_AUTH", "AI_DISABLED"].includes(s.errorCode)) {
        out.remaining = jobs.length - i - 1;
        out.stopped = s.errorMessage;
        break;
      }
    }
  }
  return out;
}

export function aiAssistMessage(r) {
  const parts = [`AI drafted ${r.values} value${r.values === 1 ? "" : "s"} and explained ${r.analyses} issue${r.analyses === 1 ? "" : "s"}.`];
  if (r.invalid) parts.push(`${r.invalid} AI answer${r.invalid === 1 ? " was" : "s were"} rejected by validation.`);
  if (r.failed) parts.push(`${r.failed} request${r.failed === 1 ? "" : "s"} failed.`);
  if (r.remaining) parts.push(`${r.remaining} still to do: ${r.stopped} Run it again to continue.`);
  return parts.join(" ");
}

// Suggestions stored before prompt version 2026-10-28.2 used different field names.
function upgradeOutput(o) {
  if (!o || o.likelyRootCause !== undefined) return o;
  return {
    findingId: o.findingId,
    evidenceRefs: [],
    likelyRootCause: o.rootCause?.summary ?? null,
    confidence: o.confidence ?? null,
    uncertainties: [...(o.hypotheses || []), ...(o.needsMoreInfo ? [o.needsMoreInfo] : [])],
    recommendedAction: o.recommendedFix ?? null,
    proposedValue: o.proposedValue ?? null,
    patchCandidate: null,
    validationRequirements: o.validationSteps || [],
    risk: o.riskLevel ?? null,
    manualReviewReason: o.manualReason ?? null,
    warnings: o.warnings || [],
  };
}

export function serializeSuggestion(s) {
  const output = upgradeOutput(safeJsonParse(s.outputJson));
  return {
    id: s.id,
    kind: s.kind,
    findingKey: s.findingKey,
    executionId: s.executionId,
    provider: s.provider,
    model: s.model,
    status: s.status,
    output,
    errors: safeJsonParse(s.validationJson, {})?.errors ?? [],
    errorCode: s.errorCode,
    errorMessage: s.errorMessage,
    createdAt: s.createdAt,
  };
}

/** Latest suggestion per key (execution id or finding key), shop-scoped. */
export async function latestSuggestions(db, shop, where, keyOf) {
  const rows = await db.aiSuggestion.findMany({ where: { shop, ...where }, orderBy: { createdAt: "desc" }, take: 500 });
  const out = {};
  for (const r of rows) {
    const k = keyOf(r);
    if (k && !out[k]) out[k] = serializeSuggestion(r);
  }
  return out;
}
