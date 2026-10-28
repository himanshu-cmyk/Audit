// Shared (client + server) vocabulary for the audit fixing system.
// Nothing in here performs work; it only names states and labels.

export const AUDIT_CATEGORIES = [
  "performance",
  "seo",
  "accessibility",
  "links",
  "shopify",
  "trust",
];

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export const SEVERITIES = ["critical", "high", "medium", "low"];
export const RISKS = ["low", "medium", "high"];

// Dashboard grouping. Derived from the audit finding id/category, so only
// categories that actually appear in an import are shown.
export const DISPLAY_CATEGORIES = {
  seo: "SEO",
  performance: "Performance",
  accessibility: "Accessibility",
  links: "Broken Links",
  code: "JavaScript / Code",
  images: "Images and Alt Text",
  theme: "Shopify Theme",
  trust: "Trust and Conversion",
  catalog: "Products and Collections",
};

export function displayCategoryFor(auditId, auditCategory) {
  if (auditId === "seo.img.alt-missing" || auditId === "a11y.image-alt" || auditId === "admin.media.alt-missing") {
    return "images";
  }
  if (auditId === "admin.collection-image.alt-missing") return "images";
  if (auditId.startsWith("catalog.")) return "catalog";
  if (auditId.startsWith("js.") || auditId.startsWith("code.")) return "code";
  if (auditId.startsWith("fonts.")) return "performance";
  if (auditCategory === "shopify") return "theme";
  return DISPLAY_CATEGORIES[auditCategory] ? auditCategory : "seo";
}

export const STORE_MATCH = {
  MATCHED: "MATCHED",
  MISMATCH: "MISMATCH",
  UNKNOWN: "UNKNOWN",
};

// Execution state of one planned change.
export const EXEC = {
  NEEDS_REVIEW: "NEEDS_REVIEW",
  APPROVED: "APPROVED",
  APPLYING: "APPLYING",
  APPLIED: "APPLIED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
  STALE: "STALE",
  MANUAL_REVIEW: "MANUAL_REVIEW",
};

// Verification is tracked separately from execution: a successful mutation
// is never treated as proof that the issue is resolved.
export const VERIFY = {
  NOT_STARTED: "NOT_STARTED",
  PENDING: "PENDING",
  PASSED: "PASSED",
  FAILED: "FAILED",
  UNAVAILABLE: "UNAVAILABLE",
  MANUAL_REQUIRED: "MANUAL_REQUIRED",
};

// Merchant-facing names. An applied change is only called "Completed" once
// post-update verification has passed (see execLabel).
export const EXEC_LABELS = {
  NEEDS_REVIEW: "Awaiting Approval",
  APPROVED: "Approved",
  APPLYING: "Executing",
  APPLIED: "Applied",
  FAILED: "Failed",
  SKIPPED: "Rejected",
  STALE: "Conflict Detected",
  MANUAL_REVIEW: "Manual Review Required",
};

export function execLabel(status, verificationStatus) {
  if (status === EXEC.APPLIED) {
    return verificationStatus === VERIFY.PASSED ? "Completed" : "Applied, not verified";
  }
  return EXEC_LABELS[status] || status;
}

// Proposal lifecycle names used in docs, history filters and exports. "draft"
// is an AI suggestion that has not been copied into a change (AiSuggestion);
// "verification_pending" covers applied changes whose read-back is not done.
export function proposalState(status, verificationStatus) {
  switch (status) {
    case EXEC.NEEDS_REVIEW:
      return "pending_review";
    case EXEC.APPROVED:
      return "approved";
    case EXEC.APPLYING:
      return "executing";
    case EXEC.APPLIED:
      return verificationStatus === VERIFY.PASSED
        ? "verified"
        : verificationStatus === VERIFY.FAILED
          ? "verification_failed"
          : "verification_pending";
    case EXEC.SKIPPED:
      return "rejected";
    case EXEC.STALE:
      return "stale";
    case EXEC.FAILED:
      return "failed";
    case EXEC.MANUAL_REVIEW:
      return "manual_review";
    default:
      return "unknown";
  }
}

export const VERIFY_LABELS = {
  NOT_STARTED: "Not verified",
  PENDING: "Waiting for Shopify",
  PASSED: "Verification Passed",
  FAILED: "Verification Failed",
  UNAVAILABLE: "Verification unavailable",
  MANUAL_REQUIRED: "Manual verification required",
};

export const SEVERITY_TONE = {
  critical: "critical",
  high: "warning",
  medium: "caution",
  low: "neutral",
};

export const RISK_TONE = { low: "success", medium: "caution", high: "critical" };

export function execTone(status, verificationStatus) {
  switch (status) {
    case EXEC.APPLIED:
      return verificationStatus === VERIFY.PASSED ? "success" : "warning";
    case EXEC.MANUAL_REVIEW:
      return "caution";
    case EXEC.FAILED:
      return "critical";
    case EXEC.STALE:
      return "warning";
    case EXEC.APPROVED:
    case EXEC.APPLYING:
      return "info";
    default:
      return "neutral";
  }
}

export function verifyTone(status) {
  switch (status) {
    case VERIFY.PASSED:
      return "success";
    case VERIFY.FAILED:
      return "critical";
    case VERIFY.PENDING:
    case VERIFY.MANUAL_REQUIRED:
      return "caution";
    default:
      return "neutral";
  }
}

// Finding-level status shown on the dashboard, derived from its plans.
export const FINDING_STATUS = {
  READY: "Ready to Fix",
  MANUAL: "Requires Manual Action",
  MANUAL_REVIEW: "Requires Manual Review",
  BLOCKED: "Blocked: store not confirmed",
  NEEDS_REVIEW: "Needs Review",
  APPROVED: "Approved",
  APPLYING: "Applying",
  VERIFIED: "Verification Passed",
  VERIFY_FAILED: "Verification Failed",
  APPLIED: "Applied",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};

export function findingStatus({ supported, canModify, plans, manualReview = false }) {
  if (!supported) return FINDING_STATUS.MANUAL;
  if (!plans || plans.length === 0) {
    if (manualReview) return FINDING_STATUS.MANUAL_REVIEW;
    return canModify ? FINDING_STATUS.READY : FINDING_STATUS.BLOCKED;
  }
  const has = (fn) => plans.some(fn);
  if (has((p) => p.status === EXEC.APPLYING)) return FINDING_STATUS.APPLYING;
  if (has((p) => p.status === EXEC.FAILED)) return FINDING_STATUS.FAILED;
  if (has((p) => p.status === EXEC.APPLIED && p.verificationStatus === VERIFY.FAILED)) {
    return FINDING_STATUS.VERIFY_FAILED;
  }
  if (has((p) => p.status === EXEC.MANUAL_REVIEW)) return FINDING_STATUS.MANUAL_REVIEW;
  if (has((p) => p.status === EXEC.NEEDS_REVIEW || p.status === EXEC.STALE)) {
    return FINDING_STATUS.NEEDS_REVIEW;
  }
  if (has((p) => p.status === EXEC.APPROVED)) return FINDING_STATUS.APPROVED;
  const applied = plans.filter((p) => p.status === EXEC.APPLIED);
  if (applied.length && applied.every((p) => p.verificationStatus === VERIFY.PASSED)) {
    return FINDING_STATUS.VERIFIED;
  }
  if (applied.length) return FINDING_STATUS.APPLIED;
  return FINDING_STATUS.SKIPPED;
}

// The five action classes every imported finding falls into. Imported findings
// never start with execution authorization, whatever their class.
export const ACTION_CLASSES = {
  admin_api: "Admin API fix (after resource check and approval)",
  needs_evidence: "Needs more evidence",
  theme_patch: "Theme patch candidate (preview)",
  manual: "Manual recommendation",
  unsupported: "Unsupported",
};

// What a change touches. Admin changes are shared data and are live immediately;
// they are never isolated by choosing a draft theme.
export const CHANGE_SCOPES = {
  admin_shared: {
    label: "Shopify Admin data (live)",
    impact:
      "Updates shared Shopify Admin data. It takes effect on your live storefront immediately and is not limited to any theme.",
  },
  theme_unpublished: {
    label: "Unpublished theme file",
    impact:
      "Edits a file in the selected unpublished theme only. Your live store is unaffected until you publish that theme yourself.",
  },
};
