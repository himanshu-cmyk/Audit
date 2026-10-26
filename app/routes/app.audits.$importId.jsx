/* eslint-disable react/prop-types -- this project does not use PropTypes; props come from loaders */
import { useMemo, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  DISPLAY_CATEGORIES,
  EXEC,
  FINDING_STATUS,
  RISKS,
  SEVERITIES,
  STORE_MATCH,
  VERIFY,
  findingStatus,
} from "../fixes/constants";
import { FixError } from "../fixes/graphql.server";
import { listThemes } from "../fixes/handlers/theme.server";
import { toActionError } from "../fixes/http.server";
import {
  CHANGE_SCOPES,
  classifyFinding,
  fixTypesForAuditId,
  manualReason,
  themeWritesStatus,
} from "../fixes/registry.server";
import {
  confirmStore,
  findingsOf,
  loadImport,
  prepareFinding,
  serializePlan,
} from "../fixes/service.server";
import { canModifyStore } from "../fixes/storeMatch.server";
import { safeJsonParse } from "../fixes/text";
import { PlanBadges, RiskBadge, SeverityBadge, flag, fmtDate, inputStyle, preStyle } from "../fixes/ui";

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const imp = await loadImport(db, session.shop, params.importId);
  if (!imp) throw new Response("Audit import not found", { status: 404 });

  const plans = (
    await db.fixExecution.findMany({
      where: { shop: session.shop, importId: imp.id },
      orderBy: { createdAt: "asc" },
    })
  ).map(serializePlan);
  const canModify = canModifyStore(imp);

  const findings = findingsOf(imp).map((f) => {
    const defs = fixTypesForAuditId(f.auditId);
    const types = defs.map((d) => d.type);
    // Changes are shared between findings that target the same resource.
    const own = plans.filter(
      (p) =>
        p.findingKey === f.key ||
        (types.includes(p.fixType) && (p.targetUrl === null || f.affectedUrls.includes(p.targetUrl))),
    );
    const classification = classifyFinding(f);
    return {
      ...f,
      supported: defs.length > 0,
      classification,
      changeScopes: classification.changeScopes.map((s) => ({ key: s, ...CHANGE_SCOPES[s] })),
      fixTypes: defs.map((d) => ({ type: d.type, label: d.label, kind: d.executionKind, risk: d.risk })),
      needsTheme: defs.some((d) => d.executionKind === "theme"),
      risk: defs.length ? defs[0].risk : f.audit?.risk ?? null,
      manualReason: defs.length ? null : manualReason(f),
      plans: own.map((p) => ({ id: p.id, status: p.status, verificationStatus: p.verificationStatus, resourceLabel: p.resourceLabel, fixType: p.fixType })),
      status: findingStatus({
        supported: defs.length > 0,
        canModify,
        plans: own,
        manualReview: classification.status === "manual_review",
      }),
    };
  });

  let themes = [];
  let themeError = null;
  if (canModify && findings.some((f) => f.needsTheme)) {
    try {
      themes = await listThemes(admin);
    } catch (err) {
      if (!(err instanceof FixError)) throw err;
      themeError = err.message;
    }
  }

  return {
    audit: {
      id: imp.id,
      fileName: imp.fileName,
      sourceFormat: imp.sourceFormat,
      auditedUrl: imp.auditedUrl,
      auditedHost: imp.auditedHost,
      auditDate: imp.auditDate,
      overallScore: imp.overallScore,
      grade: imp.grade,
      storeMatch: imp.storeMatch,
      storeMatchNote: imp.storeMatchNote,
      storeConfirmedAt: imp.storeConfirmedAt,
      warnings: safeJsonParse(imp.importWarnings, []),
      createdAt: imp.createdAt,
    },
    shop: session.shop,
    canModify,
    findings,
    planCounts: {
      total: plans.length,
      needsReview: plans.filter((p) => p.status === EXEC.NEEDS_REVIEW || p.status === EXEC.STALE).length,
      approved: plans.filter((p) => p.status === EXEC.APPROVED).length,
      applying: plans.filter((p) => p.status === EXEC.APPLYING).length,
      applied: plans.filter((p) => p.status === EXEC.APPLIED).length,
      verified: plans.filter((p) => p.verificationStatus === VERIFY.PASSED).length,
      verifyFailed: plans.filter((p) => p.verificationStatus === VERIFY.FAILED).length,
      failed: plans.filter((p) => p.status === EXEC.FAILED).length,
    },
    themes,
    themeError,
    themeWrites: themeWritesStatus(session),
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "confirmStore") {
      await confirmStore({
        db,
        session,
        importId: params.importId,
        typedHost: String(form.get("typedHost") || ""),
        acknowledged: form.get("acknowledged") === "yes",
      });
      return { ok: true, message: "Store association confirmed." };
    }
    if (intent === "prepare") {
      const themeId = form.get("themeId");
      const r = await prepareFinding({
        db,
        admin,
        session,
        importId: params.importId,
        findingKey: String(form.get("findingKey") || ""),
        themeId: typeof themeId === "string" && themeId ? themeId : null,
        acknowledgeUnconfirmed: form.get("acknowledgeUnconfirmed") === "yes",
      });
      const n = r.created + r.updated;
      return {
        ok: true,
        findingKey: String(form.get("findingKey")),
        message:
          n > 0
            ? `${n} change${n === 1 ? "" : "s"} ready for review.${r.unchanged ? ` ${r.unchanged} already approved or applied were left as they are.` : ""}`
            : r.unchanged
              ? "All changes for this finding are already approved or applied."
              : "No automatic changes could be prepared for this finding.",
        manual: r.manual,
      };
    }
    return { ok: false, error: "Unknown action." };
  } catch (err) {
    return { ...toActionError(err), findingKey: String(form.get("findingKey") || "") };
  }
};

function StoreMatchSection({ audit, canModify }) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  if (audit.storeMatch === STORE_MATCH.MATCHED) {
    return <s-banner tone="success" heading="Audit matches this store">{audit.storeMatchNote}</s-banner>;
  }
  if (audit.storeMatch === STORE_MATCH.UNKNOWN) {
    return (
      <s-banner tone="warning" heading="Review only: store changes are blocked">
        {audit.storeMatchNote} You can review the findings, but fixes cannot be applied from this import.
      </s-banner>
    );
  }
  if (canModify) {
    return (
      <s-banner tone="info" heading="Store association confirmed">
        You confirmed on {fmtDate(audit.storeConfirmedAt)} that {audit.auditedHost} is served by this store.
      </s-banner>
    );
  }
  return (
    <s-banner tone="warning" heading="Audited domain does not match this store">
      <s-stack direction="block" gap="small">
        <s-paragraph>
          {audit.storeMatchNote} Store changes are blocked until you confirm this domain belongs to this store (for
          example, a secondary domain). Changes only ever apply to the store you are logged in to.
        </s-paragraph>
        <label htmlFor="typedHost">Type {audit.auditedHost} to confirm</label>
        <input id="typedHost" style={inputStyle} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <label>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I confirm this audited
          domain is served by this Shopify store.
        </label>
        <s-button
          onClick={() => submit({ intent: "confirmStore", typedHost: typed, acknowledged: ack ? "yes" : "no" }, { method: "post" })}
          {...flag("disabled", !ack || !typed || navigation.state !== "idle")}
        >
          Confirm store association
        </s-button>
      </s-stack>
    </s-banner>
  );
}

function FindingCard({ finding, canModify, themes, themeError, actionData, busy }) {
  const submit = useSubmit();
  const writableThemes = themes.filter((t) => t.writable);
  const [themeId, setThemeId] = useState(writableThemes[0]?.id || "");
  const [acknowledged, setAcknowledged] = useState(false);
  const optional = finding.classification.status === "manual_review";
  const result = actionData?.findingKey === finding.key ? actionData : null;
  const prepare = () =>
    submit(
      {
        intent: "prepare",
        findingKey: finding.key,
        ...(finding.needsTheme ? { themeId } : {}),
        ...(optional && acknowledged ? { acknowledgeUnconfirmed: "yes" } : {}),
      },
      { method: "post" },
    );

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text type="strong">{finding.title}</s-text>
          <SeverityBadge severity={finding.severity} />
          <RiskBadge risk={finding.risk} />
          <s-badge tone={finding.classification.status === "auto" ? "info" : "neutral"}>{finding.classification.label}</s-badge>
          {finding.changeScopes.map((s) => (
            <s-badge key={s.key} tone={s.key === "admin_shared" ? "warning" : "neutral"}>
              {s.label}
            </s-badge>
          ))}
          <s-badge
            tone={
              finding.status === FINDING_STATUS.VERIFIED
                ? "success"
                : finding.status === FINDING_STATUS.FAILED || finding.status === FINDING_STATUS.VERIFY_FAILED
                  ? "critical"
                  : "neutral"
            }
          >
            {finding.status}
          </s-badge>
        </s-stack>
        <s-text color="subdued">
          {finding.affectedUrls.length} affected page{finding.affectedUrls.length === 1 ? "" : "s"} · audit id {finding.auditId}
        </s-text>

        <details>
          <summary>Details, evidence and recommendation</summary>
          <s-stack direction="block" gap="small">
            {finding.description && <s-paragraph>{finding.description}</s-paragraph>}
            {finding.evidence && (
              <s-box padding="small" background="subdued" borderRadius="base">
                <s-text type="strong">Evidence from the audit</s-text>
                <pre style={preStyle}>{finding.evidence}</pre>
              </s-box>
            )}
            {finding.recommendation && (
              <s-paragraph>
                <s-text type="strong">Recommendation: </s-text>
                {finding.recommendation}
              </s-paragraph>
            )}
            {finding.audit?.generatedFix && (
              <s-box padding="small" background="subdued" borderRadius="base">
                <s-text type="strong">Audit&apos;s suggested fix (for reference only, never executed)</s-text>
                <pre style={preStyle}>{finding.audit.generatedFix}</pre>
              </s-box>
            )}
            {finding.affectedUrls.length > 0 && (
              <s-box>
                <s-text type="strong">Affected pages</s-text>
                <pre style={preStyle}>{finding.affectedUrls.join("\n")}</pre>
              </s-box>
            )}
            {finding.supported ? (
              <s-stack direction="block" gap="small-200">
                {optional && (
                  <s-paragraph>
                    <s-text type="strong">Why this needs manual review: </s-text>
                    {finding.classification.reason}
                  </s-paragraph>
                )}
                <s-paragraph>
                  <s-text type="strong">{optional ? "Related improvement available: " : "Supported automatic changes: "}</s-text>
                  {finding.fixTypes.map((t) => t.label).join(", ")}. The app first checks the cause in your store, and
                  each change needs your review and approval.
                </s-paragraph>
                {finding.changeScopes.map((s) => (
                  <s-paragraph key={s.key}>
                    <s-text type="strong">{s.label}: </s-text>
                    {s.impact}
                  </s-paragraph>
                ))}
              </s-stack>
            ) : (
              <s-paragraph>
                <s-text type="strong">Why this is manual: </s-text>
                {finding.manualReason}
              </s-paragraph>
            )}
            {finding.plans.length > 0 && (
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Prepared changes</s-text>
                {finding.plans.map((p) => (
                  <s-stack key={p.id} direction="inline" gap="small" alignItems="center">
                    <s-text>{p.resourceLabel}</s-text>
                    <PlanBadges plan={p} />
                  </s-stack>
                ))}
              </s-stack>
            )}
          </s-stack>
        </details>

        {finding.supported && canModify && (
          <s-stack direction="inline" gap="small" alignItems="center">
            {optional && (
              <label>
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} /> I
                understand this may not resolve the audit finding
              </label>
            )}
            {finding.needsTheme && (
              <>
                <s-text color="subdued">Theme file fixes only (Admin data is never limited to a theme):</s-text>
                {themeError && <s-text tone="critical">{themeError}</s-text>}
                {writableThemes.length === 0 && !themeError ? (
                  <s-text color="subdued">
                    No unpublished or development theme found. Duplicate your live theme in Online Store &gt; Themes
                    first; the app never edits the live theme.
                  </s-text>
                ) : (
                  <select
                    aria-label="Theme to patch"
                    style={{ ...inputStyle, width: "auto" }}
                    value={themeId}
                    onChange={(e) => setThemeId(e.target.value)}
                  >
                    {writableThemes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.role.toLowerCase()})
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
            <s-button
              onClick={prepare}
              {...flag("disabled", busy || (finding.needsTheme && !themeId) || (optional && !acknowledged))}
            >
              {finding.plans.length ? "Refresh proposed changes" : optional ? "Prepare related improvement" : "Prepare fix for review"}
            </s-button>
          </s-stack>
        )}

        {result && (
          <s-banner tone={result.ok ? "success" : "critical"} heading={result.ok ? result.message : result.error}>
            {result.manual?.length > 0 && (
              <s-unordered-list>
                {result.manual.map((m, i) => (
                  <s-list-item key={i}>
                    {m.url ? `${m.url}: ` : ""}
                    {m.reason}
                  </s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-banner>
        )}
      </s-stack>
    </s-box>
  );
}

const ALL = "all";

export default function FixDashboard() {
  const { audit, canModify, findings, planCounts, themes, themeError, themeWrites } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" || planCounts.applying > 0;
  const [filters, setFilters] = useState({ category: ALL, severity: ALL, risk: ALL, fixability: ALL, status: ALL });

  const presentCategories = useMemo(
    () => Object.keys(DISPLAY_CATEGORIES).filter((k) => findings.some((f) => f.displayCategory === k)),
    [findings],
  );
  const statuses = useMemo(() => [...new Set(findings.map((f) => f.status))], [findings]);
  const visible = findings.filter(
    (f) =>
      (filters.category === ALL || f.displayCategory === filters.category) &&
      (filters.severity === ALL || f.severity === filters.severity) &&
      (filters.risk === ALL || f.risk === filters.risk) &&
      (filters.fixability === ALL || (filters.fixability === "auto") === f.supported) &&
      (filters.status === ALL || f.status === filters.status),
  );
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const autoCount = findings.filter((f) => f.classification.status === "auto").length;
  const reviewCount = findings.filter((f) => f.classification.status === "manual_review").length;
  const setFilter = (k) => (e) => setFilters((prev) => ({ ...prev, [k]: e.target.value }));

  const filterSelect = (key, label, options) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <s-text>{label}</s-text>
      <select style={{ ...inputStyle, width: "auto" }} value={filters[key]} onChange={setFilter(key)}>
        <option value={ALL}>All</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <s-page heading={`Fix issues: ${audit.auditedHost || "unknown domain"}`}>
      <s-link slot="breadcrumb-actions" href="/app/audits">
        Audit results
      </s-link>
      <s-button slot="primary-action" href={`/app/audits/${audit.id}/review`} {...flag("disabled", planCounts.total === 0)}>
        {`Review changes (${planCounts.needsReview + planCounts.approved})`}
      </s-button>

      <s-stack direction="block" gap="base">
        <StoreMatchSection audit={audit} canModify={canModify} />
        {audit.warnings.length > 0 && (
          <s-banner tone="info" heading="Import notes" collapsible>
            <s-unordered-list>
              {audit.warnings.map((w, i) => (
                <s-list-item key={i}>{w}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        )}
        {actionData?.message && !actionData.findingKey && (
          <s-banner tone={actionData.ok ? "success" : "critical"} heading={actionData.message} />
        )}
        {actionData?.error && !actionData.findingKey && <s-banner tone="critical" heading={actionData.error} />}
        {planCounts.applying > 0 && (
          <s-banner tone="info" heading={`${planCounts.applying} change(s) are being applied`}>
            Other actions are disabled until they finish.
          </s-banner>
        )}
      </s-stack>

      <s-section heading="Summary">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text color="subdued">Audit score</s-text>
            <s-heading>{audit.overallScore != null ? `${audit.overallScore}/100 ${audit.grade || ""}` : "Not in file"}</s-heading>
            <s-text color="subdued">Audited {fmtDate(audit.auditDate)}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text color="subdued">Findings by severity</s-text>
            <s-stack direction="inline" gap="small-200">
              {SEVERITIES.map((s) => (
                <s-badge key={s} tone={s === "critical" ? "critical" : s === "high" ? "warning" : "neutral"}>
                  {`${bySeverity[s]} ${s}`}
                </s-badge>
              ))}
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text color="subdued">Fixability</s-text>
            <s-paragraph>
              {autoCount} with automatic fixes · {reviewCount} need manual review · {findings.length - autoCount - reviewCount} manual
            </s-paragraph>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text color="subdued">Changes</s-text>
            <s-paragraph>
              {planCounts.needsReview} to review · {planCounts.approved} approved · {planCounts.applied} applied
            </s-paragraph>
            <s-paragraph>
              {planCounts.verified} verified · {planCounts.verifyFailed} failed verification · {planCounts.failed} failed
            </s-paragraph>
          </s-box>
        </s-grid>
        {!themeWrites.enabled && findings.some((f) => f.needsTheme) && (
          <s-box paddingBlockStart="base">
            <s-banner tone="info" heading="Theme fixes are preview-only">
              {themeWrites.reason}
            </s-banner>
          </s-box>
        )}
      </s-section>

      <s-section heading="Findings">
        <s-stack direction="inline" gap="base">
          {filterSelect("category", "Category", presentCategories.map((k) => [k, DISPLAY_CATEGORIES[k]]))}
          {filterSelect("severity", "Severity", SEVERITIES.map((s) => [s, s]))}
          {filterSelect("risk", "Risk", RISKS.map((r) => [r, r]))}
          {filterSelect("fixability", "Fixability", [["auto", "Automatic"], ["manual", "Manual"]])}
          {filterSelect("status", "Status", statuses.map((s) => [s, s]))}
        </s-stack>
        <s-box paddingBlockStart="base">
          <s-text color="subdued">
            Showing {visible.length} of {findings.length} findings
          </s-text>
        </s-box>
        {presentCategories.map((cat) => {
          const items = visible.filter((f) => f.displayCategory === cat);
          if (!items.length) return null;
          return (
            <s-box key={cat} paddingBlockStart="base">
              <s-stack direction="block" gap="small">
                <s-heading>{DISPLAY_CATEGORIES[cat]}</s-heading>
                {items.map((f) => (
                  <FindingCard
                    key={f.key}
                    finding={f}
                    canModify={canModify}
                    themes={themes}
                    themeError={themeError}
                    actionData={actionData}
                    busy={busy}
                  />
                ))}
              </s-stack>
            </s-box>
          );
        })}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
