/* eslint-disable react/prop-types -- this project does not use PropTypes; props come from loaders */
// Small presentational helpers shared by the audit-fix routes. All values are
// rendered as React text (escaped); nothing here renders HTML from data.

import {
  EXEC_LABELS,
  RISK_TONE,
  SEVERITY_TONE,
  VERIFY,
  VERIFY_LABELS,
  execTone,
  verifyTone,
} from "./constants";

// Custom elements receive attributes as strings, so `disabled={false}` would
// still disable. Spread this instead.
export const flag = (name, on) => (on ? { [name]: true } : {});

export function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SeverityBadge({ severity }) {
  return <s-badge tone={SEVERITY_TONE[severity] || "neutral"}>{severity}</s-badge>;
}

export function RiskBadge({ risk }) {
  if (!risk) return null;
  return <s-badge tone={RISK_TONE[risk] || "neutral"}>{`${risk} risk`}</s-badge>;
}

export function PlanBadges({ plan }) {
  return (
    <s-stack direction="inline" gap="small-200">
      <s-badge tone={execTone(plan.status)}>{EXEC_LABELS[plan.status] || plan.status}</s-badge>
      {plan.verificationStatus !== VERIFY.NOT_STARTED && (
        <s-badge tone={verifyTone(plan.verificationStatus)}>
          {VERIFY_LABELS[plan.verificationStatus] || plan.verificationStatus}
        </s-badge>
      )}
    </s-stack>
  );
}

export const preStyle = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: "12px",
  maxHeight: "260px",
  overflow: "auto",
};

export const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  border: "1px solid #8a8a8a",
  borderRadius: "8px",
  font: "inherit",
};

export function ValueText({ value }) {
  if (value === null || value === undefined || value === "") {
    return <s-text color="subdued">(not set)</s-text>;
  }
  return <s-text>{String(value)}</s-text>;
}

export function DiffView({ diff }) {
  if (!diff) return null;
  return (
    <s-grid gridTemplateColumns="1fr 1fr" gap="small">
      <s-box padding="small" background="subdued" borderRadius="base">
        <s-text type="strong">Before (from line {diff.startLine})</s-text>
        <pre style={preStyle}>{diff.before.join("\n")}</pre>
      </s-box>
      <s-box padding="small" background="subdued" borderRadius="base">
        <s-text type="strong">After</s-text>
        <pre style={preStyle}>{diff.after.join("\n")}</pre>
      </s-box>
    </s-grid>
  );
}

export function beforeValueOf(plan) {
  const b = plan.before || {};
  if (plan.fixType.endsWith("_seo_title")) return b.seoTitle;
  if (plan.fixType.endsWith("_seo_description")) return b.seoDescription;
  if (plan.fixType === "product_image_alt") return b.alt;
  return null;
}
