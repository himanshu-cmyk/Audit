// Structured AI output: the schema sent to the model, and a strict server-side
// validator. The model's answer is never trusted: types and lengths are checked,
// fields the server already knows (finding, resource, current value, whether a fix
// can be automated) are taken from the server, and proposed text must pass the
// same rules as merchant input plus an unsupported-claims check.

import { validateTextValue } from "../fixes/content.server";

// OpenAPI-subset schema accepted by Gemini's generationConfig.responseSchema.
// Length limits and cross-references are enforced below, not by the model.
const STR = { type: "STRING" };
const STR_LIST = { type: "ARRAY", items: STR };
const NULLABLE_STR = { type: "STRING", nullable: true };

export const RESOURCE_TYPES = ["Product", "Collection", "MediaImage", "OnlineStoreTheme", "Page", "Article", "Shop", "None"];
const CATEGORIES = ["performance", "seo", "accessibility", "links", "shopify", "trust"];

export const PROPOSAL_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    findingId: STR,
    category: { type: "STRING", enum: CATEGORIES },
    evidenceRefs: STR_LIST,
    likelyRootCause: STR,
    confidence: { type: "NUMBER" },
    uncertainties: STR_LIST,
    recommendedAction: STR,
    proposedValue: NULLABLE_STR,
    patchCandidate: NULLABLE_STR,
    requiredResourceType: { type: "STRING", enum: RESOURCE_TYPES },
    validationRequirements: STR_LIST,
    risk: { type: "STRING", enum: ["low", "medium", "high"] },
    automationSuggested: { type: "BOOLEAN" },
    manualReviewReason: NULLABLE_STR,
  },
  required: [
    "findingId", "category", "evidenceRefs", "likelyRootCause", "confidence", "uncertainties",
    "recommendedAction", "proposedValue", "patchCandidate", "requiredResourceType",
    "validationRequirements", "risk", "automationSuggested", "manualReviewReason",
  ],
};

// Claims the model must not introduce unless the store's own data already says so.
const CLAIM_TERMS = [
  "organic", "certified", "certification", "vegan", "gluten free", "sugar free", "no added sugar",
  "natural", "all natural", "100%", "clinically", "clinical", "proven", "approved", "fda", "ayush",
  "gmp", "iso", "award", "award winning", "best", "#1", "number one", "guaranteed", "guarantee",
  "cure", "cures", "treat", "treats", "treatment", "heal", "heals", "prevent", "prevents", "doctor",
  "dermatologist", "hypoallergenic", "non gmo", "cruelty free", "handmade", "eco friendly",
  "sustainable", "imported", "patented", "authentic", "pure", "chemical free", "preservative free",
  "free shipping", "discount", "sale", "cheapest", "lowest price", "limited time",
];

// Lower-case words separated by single spaces. A "." is kept only inside a
// number (e.g. "1.5"), so sentence punctuation never prevents a match.
const normalize = (s) =>
  ` ${String(s || "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\.(?!\d)|(?<!\d)\./g, " ")
    .replace(/[^\p{L}\p{N}%#.\s]/gu, " ")
    .replace(/\s+/g, " ")} `;

/** Terms and numbers in `proposal` that do not appear anywhere in `sourceText`. */
export function unsupportedClaims(proposal, sourceText) {
  const p = normalize(proposal);
  const src = normalize(sourceText);
  const terms = CLAIM_TERMS.filter((t) => {
    const needle = ` ${t} `;
    return p.includes(needle) && !src.includes(needle);
  });
  const numbers = [...new Set(p.match(/\d+(?:[.,]\d+)?/g) || [])].filter((n) => !src.includes(n));
  return [...terms, ...numbers];
}

const cap = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : null);
const capList = (v, n = 8, len = 300) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n).map((x) => cap(x, len)) : null;

/**
 * Validates a raw model answer. `ctx`: { findingId, category, kind: "value" |
 * "analysis", evidenceIds, expectedResourceType, fieldRules, currentValue,
 * sourceText }. Returns { ok, proposal, errors }. Identity fields (finding,
 * category, resource) come from the server; the model's copies must agree.
 */
export function validateAiProposal(raw, ctx) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, proposal: null, errors: ["The AI response was not a JSON object."] };
  }
  if (raw.findingId !== ctx.findingId) errors.push("The AI answered about a different finding.");
  if (ctx.category && raw.category !== ctx.category) errors.push("The AI used a different category than the finding.");

  const known = ctx.evidenceIds || new Set();
  const evidenceRefs = capList(raw.evidenceRefs, 12, 20);
  if (!evidenceRefs) errors.push("evidenceRefs must be a list.");
  const unknownRefs = (evidenceRefs || []).filter((r) => !known.has(r));
  if (unknownRefs.length) errors.push(`The AI cited evidence that was not provided: ${unknownRefs.join(", ")}.`);

  const likelyRootCause = cap(raw.likelyRootCause, 600);
  if (!likelyRootCause) errors.push("Missing likely root cause.");
  const uncertainties = capList(raw.uncertainties);
  const validationRequirements = capList(raw.validationRequirements);
  if (!uncertainties || !validationRequirements) errors.push("uncertainties and validationRequirements must be lists of text.");
  const recommendedAction = cap(raw.recommendedAction, 800);
  if (!recommendedAction) errors.push("Missing recommended action.");
  if (!["low", "medium", "high"].includes(raw.risk)) errors.push("Invalid risk level.");
  if (typeof raw.confidence !== "number" || !(raw.confidence >= 0 && raw.confidence <= 1)) {
    errors.push("Confidence must be a number between 0 and 1.");
  }
  if (typeof raw.automationSuggested !== "boolean") errors.push("automationSuggested must be true or false.");
  if (!RESOURCE_TYPES.includes(raw.requiredResourceType)) {
    errors.push("Unknown resource type.");
  } else if (ctx.expectedResourceType && raw.requiredResourceType !== ctx.expectedResourceType) {
    errors.push(`The AI targeted a ${raw.requiredResourceType}, but this change edits a ${ctx.expectedResourceType}.`);
  }
  const manualReviewReason = raw.manualReviewReason == null ? null : cap(raw.manualReviewReason, 600);

  if (raw.proposedValue != null && raw.patchCandidate != null) {
    errors.push("The AI returned both a value and a code patch; only one is allowed.");
  }
  // Code from the model is never applied. In an analysis it is kept only as
  // illustrative text; in a value suggestion it is rejected.
  let patchCandidate = null;
  if (raw.patchCandidate != null) {
    if (ctx.kind === "value") errors.push("Code patches are not accepted for this change.");
    else if (typeof raw.patchCandidate !== "string") errors.push("patchCandidate must be text.");
    else patchCandidate = raw.patchCandidate.slice(0, 4000);
  }

  let proposedValue = null;
  let warnings = [];
  if (ctx.kind === "value" && raw.proposedValue != null) {
    if (typeof raw.proposedValue !== "string") {
      errors.push("Proposed value must be text.");
    } else {
      const v = validateTextValue(raw.proposedValue, ctx.fieldRules, { previous: ctx.currentValue });
      errors.push(...v.errors.map((e) => `Proposed value: ${e}`));
      warnings = v.warnings;
      if (/https?:\/\/|www\./i.test(raw.proposedValue)) errors.push("Proposed value must not contain links.");
      const unsupported = unsupportedClaims(raw.proposedValue, ctx.sourceText);
      if (unsupported.length) {
        errors.push(`Proposed value makes claims not found in your store's data: ${unsupported.join(", ")}.`);
      }
      if (!(evidenceRefs || []).length) errors.push("A proposed value must cite the evidence it is based on.");
      proposedValue = v.value;
    }
  }
  if (ctx.kind === "value" && raw.proposedValue == null && !manualReviewReason && !(uncertainties || []).length) {
    errors.push("The AI gave no proposed value and no reason.");
  }

  return {
    ok: errors.length === 0,
    errors,
    proposal: {
      findingId: ctx.findingId,
      category: ctx.category ?? null,
      evidenceRefs: (evidenceRefs || []).filter((r) => known.has(r)),
      likelyRootCause,
      confidence: typeof raw.confidence === "number" ? Math.round(raw.confidence * 100) / 100 : null,
      uncertainties: uncertainties || [],
      recommendedAction,
      proposedValue,
      patchCandidate,
      requiredResourceType: RESOURCE_TYPES.includes(raw.requiredResourceType) ? raw.requiredResourceType : null,
      validationRequirements: validationRequirements || [],
      risk: ["low", "medium", "high"].includes(raw.risk) ? raw.risk : null,
      automationSuggested: raw.automationSuggested === true,
      manualReviewReason,
      warnings,
    },
  };
}
