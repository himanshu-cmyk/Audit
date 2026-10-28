/* eslint-disable react/prop-types -- this project does not use PropTypes; props come from loaders */
// Small presentational helpers shared by the audit-fix routes. All values are
// rendered as React text (escaped); nothing here renders HTML from data.

import {
  execLabel,
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
      <s-badge tone={execTone(plan.status, plan.verificationStatus)}>{execLabel(plan.status, plan.verificationStatus)}</s-badge>
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

// Shows an AI recommendation or analysis. Always labelled as advisory: it is
// not a validated fix proposal until the merchant uses it and approves it.
export function AiPanel({ suggestion, onUse, useDisabled }) {
  if (!suggestion) return null;
  const s = suggestion;
  const o = s.output;
  const heading =
    s.status === "VALID"
      ? `AI recommendation (${s.model}), advisory only`
      : s.status === "INVALID"
        ? "AI recommendation rejected by validation"
        : "AI request failed";
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text type="strong">{heading}</s-text>
          {o?.confidence != null && <s-badge tone="neutral">{`Confidence ${Math.round(o.confidence * 100)}%`}</s-badge>}
          {o?.risk && <RiskBadge risk={o.risk} />}
          <s-text color="subdued">{fmtDate(s.createdAt)}</s-text>
        </s-stack>
        {s.status === "ERROR" && <s-text tone="critical">{s.errorMessage}</s-text>}
        {s.status === "INVALID" && (
          <s-unordered-list>
            {s.errors.map((e, i) => (
              <s-list-item key={i}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        )}
        {o && (
          <>
            {o.proposedValue && s.status === "VALID" && (
              <s-box padding="small" background="subdued" borderRadius="base">
                <s-text type="strong">Suggested value: </s-text>
                <s-text>{o.proposedValue}</s-text>
              </s-box>
            )}
            {o.likelyRootCause && (
              <s-paragraph>
                <s-text type="strong">Likely root cause: </s-text>
                {o.likelyRootCause}
                {o.evidenceRefs?.length > 0 ? ` (based on evidence ${o.evidenceRefs.join(", ")})` : " (no evidence cited)"}
              </s-paragraph>
            )}
            {o.uncertainties?.length > 0 && (
              <s-paragraph>
                <s-text type="strong">Uncertainties: </s-text>
                {o.uncertainties.join(" · ")}
              </s-paragraph>
            )}
            {o.recommendedAction && (
              <s-paragraph>
                <s-text type="strong">Recommended action: </s-text>
                {o.recommendedAction}
              </s-paragraph>
            )}
            {o.validationRequirements?.length > 0 && (
              <s-paragraph>
                <s-text type="strong">How to verify: </s-text>
                {o.validationRequirements.join(" · ")}
              </s-paragraph>
            )}
            {o.patchCandidate && (
              <s-box padding="small" background="subdued" borderRadius="base">
                <s-text type="strong">Illustrative code from the AI (unverified, never applied by this app)</s-text>
                <pre style={preStyle}>{o.patchCandidate}</pre>
              </s-box>
            )}
            {o.manualReviewReason && <s-text color="subdued">Manual work needed: {o.manualReviewReason}</s-text>}
            {typeof o.automationSuggested === "boolean" && (
              <s-text color="subdued">
                AI opinion on automation: {o.automationSuggested ? "could be automated" : "manual"}. The app&apos;s own
                checks decide what can run.
              </s-text>
            )}
          </>
        )}
        {onUse && s.status === "VALID" && o?.proposedValue && (
          <s-button variant="secondary" onClick={onUse} {...flag("disabled", useDisabled)}>
            Use this suggestion (you can still edit it)
          </s-button>
        )}
      </s-stack>
    </s-box>
  );
}

const SOURCE_LABELS = {
  ai: "AI suggestion, approved unchanged",
  ai_edited: "AI suggestion, edited by merchant",
  suggested: "App suggestion from store data",
  merchant: "Written by merchant",
  deterministic_patch: "Deterministic theme patch",
  restore: "Restore of the recorded previous value",
};

export function valueSourceLabel(source) {
  if (!source?.type) return null;
  const base = SOURCE_LABELS[source.type] || source.type;
  return source.model ? `${base} (${source.provider} ${source.model})` : base;
}

export function beforeValueOf(plan) {
  const b = plan.before || {};
  if (plan.fixType.endsWith("_seo_title")) return b.seoTitle;
  if (plan.fixType.endsWith("_seo_description")) return b.seoDescription;
  if (plan.fixType === "product_image_alt") return b.alt;
  return null;
}
