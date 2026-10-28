// The single source of truth for what this app is allowed to change.
// A fix type exists here only if it has a deterministic execution handler and a
// verification handler. Audit files, the browser and AI output cannot add to it.

import { ACTION_CLASSES, CHANGE_SCOPES } from "./constants";
import { canModifyStore } from "./storeMatch.server";
import { isKnownSourceId } from "./reportContract.server";

export { ACTION_CLASSES, CHANGE_SCOPES };
import { FixError } from "./graphql.server";
import { makeSeoHandler } from "./handlers/seo.server";
import { makeImageAltHandler } from "./handlers/imageAlt.server";
import { makeThemeHandler } from "./handlers/theme.server";

// seo.title.missing is deliberately absent: every product and collection has a
// title, so a missing <title> tag is a theme problem, not Admin data.
const TITLE_IDS = ["seo.title.length"];
const DESCRIPTION_IDS = ["seo.meta-description.missing", "seo.meta-description.length"];
const ALT_IDS = ["seo.img.alt-missing", "a11y.image-alt", "admin.media.alt-missing"];

const ADMIN_API = "admin_api";
const THEME = "theme";

function define(type, spec) {
  return Object.freeze({
    type,
    requiresApproval: true,
    autoExecutable: true,
    changeScope: spec.executionKind === THEME ? "theme_unpublished" : "admin_shared",
    // "confirmed": the handler checks the actual root cause in Shopify before
    // proposing a change. "unconfirmed": the change is well defined but may not
    // be what the audit flagged, so it is only offered as an acknowledged extra.
    rootCause: "confirmed",
    ...spec,
  });
}

export const FIX_TYPES = Object.freeze({
  product_seo_title: define("product_seo_title", {
    label: "Product SEO title",
    executionKind: ADMIN_API,
    targetKind: "product",
    resourceTypes: ["Product"],
    auditFindingIds: TITLE_IDS,
    requiredInputs: ["value"],
    risk: "low",
    requiredScopes: ["write_products"],
    handler: makeSeoHandler({ resourceType: "Product", field: "title" }),
  }),
  product_seo_description: define("product_seo_description", {
    label: "Product SEO description",
    executionKind: ADMIN_API,
    targetKind: "product",
    resourceTypes: ["Product"],
    auditFindingIds: DESCRIPTION_IDS,
    requiredInputs: ["value"],
    risk: "low",
    requiredScopes: ["write_products"],
    handler: makeSeoHandler({ resourceType: "Product", field: "description" }),
  }),
  collection_seo_title: define("collection_seo_title", {
    label: "Collection SEO title",
    executionKind: ADMIN_API,
    targetKind: "collection",
    resourceTypes: ["Collection"],
    auditFindingIds: TITLE_IDS,
    requiredInputs: ["value"],
    risk: "low",
    requiredScopes: ["write_products"],
    handler: makeSeoHandler({ resourceType: "Collection", field: "title" }),
  }),
  collection_seo_description: define("collection_seo_description", {
    label: "Collection SEO description",
    executionKind: ADMIN_API,
    targetKind: "collection",
    resourceTypes: ["Collection"],
    auditFindingIds: DESCRIPTION_IDS,
    requiredInputs: ["value"],
    risk: "low",
    requiredScopes: ["write_products"],
    handler: makeSeoHandler({ resourceType: "Collection", field: "description" }),
  }),
  product_image_alt: define("product_image_alt", {
    label: "Product image alt text",
    executionKind: ADMIN_API,
    targetKind: "product",
    resourceTypes: ["MediaImage"],
    auditFindingIds: ALT_IDS,
    requiredInputs: ["value"],
    risk: "low",
    requiredScopes: ["write_products", "write_files"],
    rootCause: "unconfirmed",
    // Found by the in-app audit directly on product media, so the cause is known.
    confirmedFor: ["admin.media.alt-missing"],
    rootCauseNote:
      "The audit counts <img> tags with no alt attribute. Most themes render product images with empty alt text as alt=\"\", which the audit does not count, so the flagged images are often theme or app images. Adding alt text to product images in Admin is a real accessibility improvement but may not resolve this finding.",
    handler: makeImageAltHandler(),
  }),
  theme_html_lang: define("theme_html_lang", {
    label: "Theme: add html lang attribute",
    executionKind: THEME,
    targetKind: "theme",
    resourceTypes: ["OnlineStoreTheme"],
    auditFindingIds: ["seo.lang.missing", "a11y.html-has-lang"],
    requiredInputs: ["themeId"],
    risk: "low",
    requiredScopes: ["write_themes"],
    handler: makeThemeHandler("theme_html_lang"),
  }),
  theme_canonical_tag: define("theme_canonical_tag", {
    label: "Theme: add canonical link tag",
    executionKind: THEME,
    targetKind: "theme",
    resourceTypes: ["OnlineStoreTheme"],
    auditFindingIds: ["seo.canonical.missing"],
    requiredInputs: ["themeId"],
    risk: "low",
    requiredScopes: ["write_themes"],
    handler: makeThemeHandler("theme_canonical_tag"),
  }),
});

// Whether a fix type's link to this finding is established without asking the merchant.
export function rootCauseConfirmed(def, auditId) {
  return def.rootCause !== "unconfirmed" || (def.confirmedFor || []).includes(auditId);
}

export function getFixType(type) {
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(FIX_TYPES, type)) {
    throw new FixError("UNSUPPORTED_FIX_TYPE", "This fix type is not supported for automatic execution.");
  }
  return FIX_TYPES[type];
}

export function fixTypesForAuditId(auditId) {
  return Object.values(FIX_TYPES).filter((d) => d.auditFindingIds.includes(auditId));
}

// Scopes actually granted to this installation (write_x implies read_x).
export function grantedScopes(session) {
  const set = new Set();
  for (const s of String(session?.scope || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    set.add(s);
    if (s.startsWith("write_")) set.add(`read_${s.slice(6)}`);
  }
  return set;
}

// Theme writes need write_themes AND Shopify's theme-modification exemption for
// the app. The exemption cannot be detected through the API before a write, so the
// operator must opt in with THEME_WRITES_ENABLED=true once Shopify has granted it.
export function themeWritesStatus(session, env = process.env) {
  if (!grantedScopes(session).has("write_themes")) {
    return { enabled: false, reason: "The app does not have the write_themes scope on this store." };
  }
  if (env.THEME_WRITES_ENABLED !== "true") {
    return {
      enabled: false,
      reason:
        "Theme file writes are disabled. This app is configured for App Store distribution, and App Store apps need a theme modification exemption granted by Shopify before they can write theme files (Shopify may decline it). Set THEME_WRITES_ENABLED=true only after Shopify confirms it. Until then, preview the exact patch here and apply it yourself in Online Store > Themes > Edit code on an unpublished theme.",
    };
  }
  return { enabled: true, reason: null };
}

// Server-side eligibility, evaluated at prepare, approval and execution time.
export function eligibilityProblems(def, { session, importRecord, env = process.env }) {
  const problems = [];
  if (!def.autoExecutable) problems.push("This fix type is not automatically executable.");
  if (!canModifyStore(importRecord)) {
    problems.push("This audit is not confirmed as belonging to this store, so store changes are blocked.");
  }
  const granted = grantedScopes(session);
  const missing = def.requiredScopes.filter((s) => !granted.has(s));
  if (missing.length) problems.push(`Missing required permission(s): ${missing.join(", ")}.`);
  if (def.executionKind === THEME) {
    const t = themeWritesStatus(session, env);
    if (!t.enabled) problems.push(t.reason);
  }
  return problems;
}

const MANUAL_WHY_BY_ID = {
  "seo.title.missing":
    "Every product and collection has a title, so a missing <title> tag comes from the theme (layout/theme.liquid), not Admin data. Check the theme manually.",
};

const MANUAL_WHY = {
  set_title_admin: "Only product and collection pages can be fixed automatically. Other pages need manual edits.",
  set_meta_admin: "Only product and collection pages can be fixed automatically. Other pages need manual edits.",
  add_alt_admin: "Only product media can be fixed automatically. Theme and app images need alt text set in the theme editor.",
  remove_unused_app: "High risk: removing app code can break checkout, reviews or tracking. Review apps manually.",
  adjust_contrast: "Colour changes affect the brand and need visual review.",
  consolidate_fonts: "Font changes affect the design and need visual review.",
};

export function manualReason(finding) {
  if (MANUAL_WHY_BY_ID[finding.auditId]) return MANUAL_WHY_BY_ID[finding.auditId];
  if (finding.audit?.fixType && MANUAL_WHY[finding.audit.fixType] && fixTypesForAuditId(finding.auditId).length === 0) {
    return MANUAL_WHY[finding.audit.fixType];
  }
  if (finding.audit?.autoApplicable) {
    return "The audit marks this as auto-applicable, but the change depends on your theme's structure and cannot be applied and verified deterministically. Apply it manually or with a developer.";
  }
  return "There is no deterministic, verifiable automatic fix for this issue type. Follow the recommendation manually.";
}

// Classification shown on the dashboard. "auto" means the app can check the root
// cause in Shopify and propose a verifiable change; the check itself still runs at
// prepare time and may downgrade individual pages to manual review.
export function classifyFinding(finding) {
  const out = (status, actionClass, extra) => ({ status, actionClass, actionLabel: ACTION_CLASSES[actionClass], ...extra });
  if (finding.conflict || !isKnownSourceId(finding.auditId)) {
    return out("unsupported", "unsupported", {
      label: "Unsupported",
      changeScopes: [],
      reason: finding.conflict
        ? finding.conflictNote || "The file contains conflicting entries for this finding."
        : "This issue id is not produced by the supported audit tool version, so the app cannot interpret it. Review it manually.",
    });
  }
  const defs = fixTypesForAuditId(finding.auditId);
  if (!defs.length) {
    return out("manual", "manual", { label: "Manual fix", changeScopes: [], reason: manualReason(finding) });
  }
  const unconfirmed = defs.filter((d) => !rootCauseConfirmed(d, finding.auditId));
  const scopes = [...new Set(defs.map((d) => d.changeScope))];
  if (unconfirmed.length === defs.length) {
    return out("manual_review", "needs_evidence", {
      label: "Requires Manual Review",
      changeScopes: scopes,
      reason: unconfirmed[0].rootCauseNote,
      optionalImprovement: true,
    });
  }
  const theme = defs.every((d) => d.executionKind === THEME);
  if (!theme && !(finding.affectedUrls || []).length) {
    return out("auto", "needs_evidence", {
      label: "Automatic fix (after review)",
      changeScopes: scopes,
      reason: "The report lists no affected pages, so there is no product or collection to resolve.",
    });
  }
  return out("auto", theme ? "theme_patch" : "admin_api", { label: "Automatic fix (after review)", changeScopes: scopes, reason: null });
}
