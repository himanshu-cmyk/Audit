/* eslint-disable react/prop-types -- this project does not use PropTypes; props come from loaders */
import { useMemo, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  ACTION_CLASSES,
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
  prepareAllFixable,
  prepareFinding,
  prepareSummary,
  setImportTheme,
  serializePlan,
} from "../fixes/service.server";
import { canModifyStore } from "../fixes/storeMatch.server";
import { sourceLimitations } from "../fixes/reportContract.server";
import { SOURCE_FORMATS } from "../fixes/importer.server";
import { safeJsonParse } from "../fixes/text";
import { AiPanel, PlanBadges, RiskBadge, SeverityBadge, flag, fmtDate, inputStyle, preStyle } from "../fixes/ui";
import { aiStatus } from "../ai/config.server";
import { getAiProvider } from "../ai/provider.server";
import { aiAssistImport, aiAssistMessage, analyzeFinding, latestSuggestions } from "../ai/suggest.server";

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
    const supported = defs.length > 0 && classification.status !== "unsupported";
    return {
      ...f,
      supported,
      limitations: sourceLimitations(f.auditId, f.origin ?? null),
      classification,
      changeScopes: classification.changeScopes.map((s) => ({ key: s, ...CHANGE_SCOPES[s] })),
      fixTypes: defs.map((d) => ({ type: d.type, label: d.label, kind: d.executionKind, risk: d.risk })),
      needsTheme: defs.some((d) => d.executionKind === "theme"),
      risk: defs.length ? defs[0].risk : f.audit?.risk ?? null,
      manualReason: supported ? null : classification.status === "unsupported" ? classification.reason : manualReason(f),
      plans: own.map((p) => ({ id: p.id, status: p.status, verificationStatus: p.verificationStatus, resourceLabel: p.resourceLabel, fixType: p.fixType })),
      status: findingStatus({
        supported,
        canModify,
        plans: own,
        manualReview: classification.status === "manual_review",
      }),
    };
  });

  let themes = [];
  let themeError = null;
  if (canModify) {
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
    report: {
      reportId: imp.id,
      legacy: imp.sourceFormat !== SOURCE_FORMATS.V1,
      contractVersion: imp.contractVersion,
      sourceSchemaVersion: imp.sourceSchemaVersion,
      rawSha256: imp.rawSha256,
      contentDigest: imp.contentDigest,
      generatedAt: imp.sourceGeneratedAt,
      ...safeJsonParse(imp.reportJson, {}),
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
    selectedTheme: themes.find((t) => t.id === imp.themeId && t.writable) || null,
    selectedThemeMissing: Boolean(imp.themeId) && !themes.some((t) => t.id === imp.themeId && t.writable) && !themeError,
    themeWrites: themeWritesStatus(session),
    existing: new URL(request.url).searchParams.get("existing") === "1",
    ai: aiStatus(),
    analyses: await latestSuggestions(db, session.shop, { importId: imp.id, kind: "analysis" }, (r) => r.findingKey),
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
    if (intent === "aiAnalyze") {
      // Explanation only: stored for display, never executed.
      const findingKey = String(form.get("findingKey") || "");
      const s = await analyzeFinding({ db, session, importId: params.importId, findingKey, provider: getAiProvider() });
      return {
        ok: s.status === "VALID",
        findingKey,
        message: s.status === "VALID" ? "AI analysis ready (advisory only)." : s.errorMessage || "The AI analysis failed validation.",
      };
    }
    if (intent === "selectTheme") {
      const theme = await setImportTheme({ db, admin, session, importId: params.importId, themeId: form.get("themeId") });
      return { ok: true, message: `Theme fixes for this audit will be prepared on "${theme.name}".` };
    }
    if (intent === "aiAssist") {
      // Advisory only: drafts values and explanations; nothing is approved or applied.
      const r = await aiAssistImport({ db, admin, session, importId: params.importId, provider: getAiProvider() });
      return { ok: !r.failed, message: aiAssistMessage(r) };
    }
    if (intent === "prepareAll") {
      const r = await prepareAllFixable({ db, admin, session, importId: params.importId });
      const n = r.created + r.updated;
      let aiNote = "";
      if (form.get("aiDraft") === "yes" && aiStatus().enabled) {
        const a = await aiAssistImport({ db, admin, session, importId: params.importId, provider: getAiProvider(), explain: false });
        aiNote = ` ${aiAssistMessage(a)}`;
      }
      return {
        ok: true,
        message: `${n} change${n === 1 ? "" : "s"} ready for review from ${r.findings} finding${r.findings === 1 ? "" : "s"}.${r.unchanged ? ` ${r.unchanged} already approved or applied were left as they are.` : ""}${r.manual.length ? ` ${r.manual.length} need manual review.` : ""}${r.unresolved.length ? ` ${r.unresolved.length} not found in the store.` : ""}${r.failed.length ? ` ${r.failed.length} failed.` : ""}${aiNote} Review and approve them before anything is applied.`,
        manual: [
          ...r.skipped.map((x) => ({ url: null, reason: `${x.key}: ${x.reason}` })),
          ...r.manual,
          ...r.unresolved.map((m) => ({ ...m, reason: `Not found: ${m.reason}` })),
          ...r.failed.map((m) => ({ ...m, reason: `Failed: ${m.reason}` })),
        ],
      };
    }
    if (intent === "prepare") {
      const r = await prepareFinding({
        db,
        admin,
        session,
        importId: params.importId,
        findingKey: String(form.get("findingKey") || ""),
        acknowledgeUnconfirmed: form.get("acknowledgeUnconfirmed") === "yes",
      });
      const n = r.created + r.updated;
      const findingKey = String(form.get("findingKey"));
      let aiNote = "";
      if (n > 0 && form.get("aiDraft") === "yes" && aiStatus().enabled) {
        const a = await aiAssistImport({ db, admin, session, importId: params.importId, provider: getAiProvider(), explain: false, findingKey });
        aiNote = ` ${aiAssistMessage(a)}`;
      }
      return {
        ok: n > 0 || r.unchanged > 0,
        findingKey,
        message: `${prepareSummary(r)}. ${
          n > 0
            ? `${n} change${n === 1 ? "" : "s"} ready for review.${r.unchanged ? ` ${r.unchanged} already approved or applied were left as they are.` : ""}`
            : r.unchanged
              ? "All changes for this finding are already approved or applied."
              : "No change could be prepared; see the reasons below."
        }${aiNote}`,
        manual: [
          ...r.manual,
          ...r.unresolved.map((m) => ({ ...m, reason: `Not found: ${m.reason}` })),
          ...r.failed.map((m) => ({ ...m, reason: `Failed: ${m.reason}` })),
        ],
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

const OUTCOME_SHORT = {
  change: "can get a concrete change",
  more_evidence: "need more evidence",
  merchant_action: "need your action",
  recommendation: "have a recommendation",
  unsupported: "unsupported",
};
const OUTCOME_TONE = { change: "success", more_evidence: "warning", merchant_action: "info", recommendation: "neutral", unsupported: "neutral" };

function FindingCard({ finding, canModify, selectedTheme, actionData, busy, ai, analysis }) {
  const submit = useSubmit();
  const [acknowledged, setAcknowledged] = useState(false);
  const optional = finding.classification.status === "manual_review";
  const result = actionData?.findingKey === finding.key ? actionData : null;
  const prepare = () =>
    submit(
      {
        intent: "prepare",
        findingKey: finding.key,
        aiDraft: ai.enabled ? "yes" : "no",
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
          <s-badge tone={OUTCOME_TONE[finding.classification.outcome] || "neutral"}>{finding.classification.outcomeLabel}</s-badge>
          {finding.classification.actionLabel && <s-badge tone="neutral">{finding.classification.actionLabel}</s-badge>}
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
          {finding.affectedUrls.length} affected page{finding.affectedUrls.length === 1 ? "" : "s"}
          {finding.supported ? ` · ${finding.plans.length} change${finding.plans.length === 1 ? "" : "s"} prepared` : ""} · audit id {finding.auditId}
          {finding.findingId ? ` · finding ${finding.findingId}` : ""}
        </s-text>

        <details>
          <summary>Details, evidence and recommendation</summary>
          <s-stack direction="block" gap="small">
            {finding.description && <s-paragraph>{finding.description}</s-paragraph>}
            {finding.limitations?.length > 0 && (
              <s-paragraph>
                <s-text type="strong">What this evidence can show: </s-text>
                {finding.limitations.join(" ")}
              </s-paragraph>
            )}
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
                <s-text type="strong">Affected pages (as requested by the audit; redirects are not recorded)</s-text>
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
                <s-text type="strong">
                  {finding.classification.status === "unsupported"
                    ? "Why this is unsupported: "
                    : finding.classification.outcome === "merchant_action"
                      ? "What you need to do: "
                      : finding.classification.outcome === "more_evidence"
                        ? "Why no change can be prepared yet: "
                        : "Recommendation and why it is manual: "}
                </s-text>
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
              <s-text color="subdued">
                {selectedTheme ? `Theme fix will be prepared on "${selectedTheme.name}".` : "Choose the theme to fix at the top of this page first."}
              </s-text>
            )}
            <s-button
              onClick={prepare}
              {...flag("disabled", busy || (finding.needsTheme && !selectedTheme) || (optional && !acknowledged))}
            >
              {finding.plans.length ? "Refresh proposed changes" : optional ? "Prepare related improvement" : "Prepare fix for review"}
            </s-button>
          </s-stack>
        )}

        <AiPanel suggestion={analysis} />
        <s-stack direction="inline" gap="small" alignItems="center">
          {ai.enabled ? (
            <s-button variant="tertiary" onClick={() => submit({ intent: "aiAnalyze", findingKey: finding.key }, { method: "post" })} {...flag("disabled", busy)}>
              {analysis ? "Explain again with AI" : "Explain with AI"}
            </s-button>
          ) : null}
        </s-stack>

        {result && (
          <s-banner tone={result.ok ? "success" : "critical"} heading={result.ok ? result.message : result.error || result.message}>
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

const num = (v, unit = "") => (v === null || v === undefined ? "not captured" : `${v}${unit}`);

// What the imported report is, where it came from and what its numbers can and
// cannot show. Everything here is display-only; none of it authorizes anything.
function ReportDetails({ report }) {
  const m = report.metrics;
  return (
    <s-section heading="Report details">
      <details>
        <summary>Source, integrity and limitations</summary>
        <s-stack direction="block" gap="small">
          <s-paragraph>
            Report {report.reportId}
            {report.origin === "in-app"
              ? ` · audit run by this app · ${report.scan?.products ?? 0} active products${report.scan?.productsTruncated ? " (first ones only)" : ""}${report.scan?.productCounts?.all != null ? ` of ${report.scan.productCounts.all} in the store` : ""}, ${report.scan?.collections ?? 0} collections checked`
              : report.legacy
              ? " · legacy format (validated with legacy rules)"
              : ` · source schemaVersion ${report.sourceSchemaVersion} · internal contract v${report.contractVersion}`}
          </s-paragraph>
          <s-paragraph>
            Generated {fmtDate(report.generatedAt)} · crawled {fmtDate(report.crawledAt)}
            {report.device ? ` · ${report.device}` : ""}
            {report.narrativeGeneratedBy ? ` · narrative by ${report.narrativeGeneratedBy}` : ""}
          </s-paragraph>
          {report.origin === "in-app" && (
            <s-stack direction="block" gap="small-200">
              <s-text>Published theme: {report.theme?.status === "checked" ? `checked ("${report.theme.themeName}")` : report.theme?.message || "not checked"}</s-text>
              {report.theme?.notes?.map((n, i) => (
                <s-text key={i} color="subdued">
                  {n}
                </s-text>
              ))}
              <s-text>Storefront pages: {report.storefront?.message}</s-text>
              {report.policies?.message && <s-text>Store policies: {report.policies.message}</s-text>}
              {report.storefront?.requests && (
                <s-text color="subdued">
                  Storefront requests: {report.storefront.requests.requests} sent, {report.storefront.requests.retries} retried,{" "}
                  {report.storefront.requests.cacheHits} served from this audit&apos;s cache.
                </s-text>
              )}
              <PerformanceDetails performance={report.performance} />
            </s-stack>
          )}
          {report.rawSha256 && (
            <s-text color="subdued">
              File SHA-256 {report.rawSha256} · content digest {report.contentDigest}
            </s-text>
          )}
          {report.pagesCrawled?.length > 0 && (
            <s-box>
              <s-text type="strong">Pages sampled ({report.pagesCrawled.length}; homepage links, not a full crawl)</s-text>
              <pre style={preStyle}>{report.pagesCrawled.join("\n")}</pre>
            </s-box>
          )}
          {m && (
            <s-box padding="small" background="subdued" borderRadius="base">
              <s-text type="strong">Homepage lab metrics (one browser run; not Lighthouse, PageSpeed Insights or field data)</s-text>
              <s-paragraph>
                FCP {num(m.fcpMs, " ms")} · LCP {num(m.lcpMs, " ms")}
                {m.lcpElement?.tagName ? ` (${m.lcpElement.tagName.toLowerCase()}${m.lcpElement.isLazyLoaded ? ", lazy-loaded" : ""})` : ""} · CLS (sum of
                observed shifts) {num(m.cls)} · blocking time (sum of long tasks) {num(m.blockingTimeMs, " ms")} · INP not measured
              </s-paragraph>
              {m.cdp && (
                <s-paragraph>
                  Script {num(m.cdp.scriptDurationMs, " ms")} · layout {num(m.cdp.layoutDurationMs, " ms")} · style recalculation{" "}
                  {num(m.cdp.recalcStyleDurationMs, " ms")} · JS heap {num(m.cdp.jsHeapUsedKb, " KB")}
                </s-paragraph>
              )}
              <s-text color="subdued">A missing value may mean the capture failed, not that the page is clean.</s-text>
            </s-box>
          )}
          {report.summaryNotes?.length > 0 && (
            <s-banner tone="warning" heading="The report's summaries are inconsistent">
              <s-unordered-list>
                {report.summaryNotes.map((n, i) => (
                  <s-list-item key={i}>{n}</s-list-item>
                ))}
              </s-unordered-list>
              Scores are shown for information only and never decide what can be changed.
            </s-banner>
          )}
          {report.unsupported?.length > 0 && (
            <s-box>
              <s-text type="strong">Unsupported findings ({report.unsupported.length})</s-text>
              <s-unordered-list>
                {report.unsupported.map((u) => (
                  <s-list-item key={u.findingId}>
                    {u.key}: {u.reason}
                  </s-list-item>
                ))}
              </s-unordered-list>
            </s-box>
          )}
          {report.narrative?.executiveSummary && (
            <s-box>
              <s-text type="strong">Report narrative (from the file, not verified by this app)</s-text>
              <s-paragraph>{report.narrative.executiveSummary}</s-paragraph>
            </s-box>
          )}
        </s-stack>
      </details>
    </s-section>
  );
}

// The one theme all theme fixes of this audit are prepared on. Admin fixes (SEO,
// alt text) never depend on it.
function ThemeChooser({ themes, themeError, selectedTheme, selectedThemeMissing, busy }) {
  const submit = useSubmit();
  const writable = themes.filter((t) => t.writable);
  const [choice, setChoice] = useState(selectedTheme?.id || writable[0]?.id || "");
  const [editing, setEditing] = useState(!selectedTheme);
  if (themeError) return <s-banner tone="critical" heading="Themes could not be loaded">{themeError}</s-banner>;
  if (!writable.length) {
    return (
      <s-banner tone="warning" heading="No theme available for theme fixes">
        Duplicate your live theme in Online Store &gt; Themes, then reload. The app never edits the live theme. Admin
        fixes (SEO, alt text) work without a theme.
      </s-banner>
    );
  }
  if (selectedTheme && !editing) {
    return (
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-text type="strong">Theme to fix:</s-text>
        <s-badge tone="info">{`${selectedTheme.name} (${selectedTheme.role.toLowerCase()})`}</s-badge>
        <s-button variant="tertiary" onClick={() => setEditing(true)} {...flag("disabled", busy)}>
          Change
        </s-button>
      </s-stack>
    );
  }
  return (
    <s-stack direction="block" gap="small-200">
      {selectedThemeMissing && (
        <s-banner tone="warning" heading="The theme chosen earlier is no longer available">
          It was deleted or published. Choose another unpublished theme.
        </s-banner>
      )}
      <label htmlFor="themeToFix">
        <s-text type="strong">Which theme should theme fixes go to?</s-text>
      </label>
      <s-stack direction="inline" gap="small" alignItems="center">
        <select id="themeToFix" style={{ ...inputStyle, width: "auto" }} value={choice} onChange={(e) => setChoice(e.target.value)}>
          {writable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.role.toLowerCase()})
            </option>
          ))}
        </select>
        <s-button onClick={() => submit({ intent: "selectTheme", themeId: choice }, { method: "post" })} {...flag("disabled", busy || !choice)}>
          Use this theme
        </s-button>
      </s-stack>
      <s-text color="subdued">
        Asked once for this audit. Only unpublished or development themes are listed; the live theme is never edited or
        published.
      </s-text>
    </s-stack>
  );
}

const COVERAGE_LABELS = {
  partial: "partly checked",
  not_checked: "not checked",
  rate_limited: "rate limited",
  blocked: "blocked",
  error: "error",
  not_measured: "not measured",
};

const ms = (v) => (v === null || v === undefined ? "not available" : `${(v / 1000).toFixed(2)} s`);
const plain = (v, unit = "") => (v === null || v === undefined ? "not available" : `${v}${unit}`);

// PageSpeed Insights results: lab (one Lighthouse run) and field (real users)
// are shown separately; missing values say "not available", never 0.
function PerformanceDetails({ performance }) {
  if (!performance) return null;
  if (performance.status !== "checked") return <s-text>Speed, contrast and JavaScript errors: {performance.message}</s-text>;
  const { lab, field } = performance;
  return (
    <s-box padding="small" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text type="strong">
          {`${performance.source === "lighthouse-local" ? "Lighthouse (run by the app, logged in with the storefront password)" : "Google PageSpeed Insights"} · ${performance.strategy?.toLowerCase()} · ${performance.testedUrl}${performance.fetchTime ? ` · ${fmtDate(performance.fetchTime)}` : ""}`}
        </s-text>
        <s-text>
          Lab (one Lighthouse run): performance score {plain(lab.performanceScore, "/100")} · LCP {ms(lab.lcpMs)} · FCP {ms(lab.fcpMs)} · CLS{" "}
          {plain(lab.cls)} · Total Blocking Time {plain(lab.tbtMs, " ms")} · accessibility score {plain(lab.accessibilityScore, "/100")}
        </s-text>
        <s-text>
          {field
            ? `Real users (Chrome UX Report, ${field.scope}, 75th percentile): LCP ${ms(field.lcpMs?.p75)} · INP ${plain(field.inpMs?.p75, " ms")} · CLS ${plain(field.cls?.p75)} · FCP ${ms(field.fcpMs?.p75)}`
            : "Real users: no field data available for this store."}
        </s-text>
        {performance.opportunities?.length > 0 && (
          <s-text color="subdued">
            Biggest opportunities: {performance.opportunities.map((o) => `${o.title} (~${(o.savingsMs / 1000).toFixed(1)} s)`).join(" · ")}
          </s-text>
        )}
        {performance.limitations?.map((l, i) => (
          <s-text key={i} color="subdued">
            {l}
          </s-text>
        ))}
      </s-stack>
    </s-box>
  );
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// Score per category with the formula shown, and the findings ranked by
// severity, then whether the app can fix them, then how often they occur.
function ScoreAndPriorities({ score, findings }) {
  const top = [...findings]
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        Number(b.supported) - Number(a.supported) ||
        (b.instances || 0) - (a.instances || 0),
    )
    .slice(0, 8);
  return (
    <s-section heading={score.overall === null ? "Score" : `Score: ${score.overall}/100 (grade ${score.grade})`}>
      <s-stack direction="block" gap="base">
        <s-table>
          <s-table-header-row>
            <s-table-header>Category</s-table-header>
            <s-table-header>Score</s-table-header>
            <s-table-header>Findings</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {Object.values(score.categories).map((c) => (
              <s-table-row key={c.key}>
                <s-table-cell>{c.label}</s-table-cell>
                <s-table-cell>{c.score === null ? "Not checked" : `${c.score}/100`}</s-table-cell>
                <s-table-cell>{c.count}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-text color="subdued">
          How the score works: each checked category starts at 100 and loses {score.weights.critical} points per critical,{" "}
          {score.weights.high} per high, {score.weights.medium} per medium and {score.weights.low} per low finding (minimum 0).
          The overall score is the average of the checked categories. Checks that were not checked, rate limited, blocked
          or failed never deduct points; they are listed above the score instead.
        </s-text>
        {top.length > 0 && (
          <s-stack direction="block" gap="small">
            <s-heading>What to fix first</s-heading>
            {top.map((f, i) => (
              <s-stack key={f.key} direction="inline" gap="small" alignItems="center">
                <s-text type="strong">{`${i + 1}. ${f.title}`}</s-text>
                <SeverityBadge severity={f.severity} />
                <s-badge tone={f.supported ? "info" : "neutral"}>{f.supported ? "App can fix (after approval)" : "Manual"}</s-badge>
                <s-text color="subdued">{f.recommendation}</s-text>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

const ALL = "all";

export default function FixDashboard() {
  const { audit, report, existing, canModify, findings, planCounts, themes, themeError, selectedTheme, selectedThemeMissing, themeWrites, ai, analyses } =
    useLoaderData();
  const submitTop = useSubmit();
  const [aiDraft, setAiDraft] = useState(true);
  const fixableCount = findings.filter((f) => f.supported && f.classification.status === "auto").length;
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
      (filters.fixability === ALL || f.classification.actionClass === filters.fixability) &&
      (filters.status === ALL || f.status === filters.status),
  );
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const autoCount = findings.filter((f) => f.classification.status === "auto").length;
  const reviewCount = findings.filter((f) => f.classification.status === "manual_review").length;
  const outcomeCounts = {};
  for (const f of findings) outcomeCounts[f.classification.outcome] = (outcomeCounts[f.classification.outcome] || 0) + 1;
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
        {existing && (
          <s-banner tone="info" heading="This report was already imported">
            The uploaded file has the same content as this import, so the existing import and its review history are
            shown. Importing never creates or restores approvals.
          </s-banner>
        )}
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

      {report.coverage?.length > 0 && (
        <s-box paddingBlockEnd="base">
          <s-banner tone="warning" heading="Parts of your store were not fully checked, so this audit is incomplete">
            <s-unordered-list>
              {report.coverage.map((c) => (
                <s-list-item key={c.area}>
                  <s-text type="strong">{`${c.area} (${COVERAGE_LABELS[c.status] || c.status}): `}</s-text>
                  {c.reason}
                </s-list-item>
              ))}
            </s-unordered-list>
            These parts deduct nothing from the score. Findings from the parts that did run are shown below.
          </s-banner>
        </s-box>
      )}

      {canModify && (
        <s-section heading="Fix this store">
          <s-stack direction="block" gap="base">
            {findings.some((f) => f.needsTheme) && (
              <ThemeChooser
                themes={themes}
                themeError={themeError}
                selectedTheme={selectedTheme}
                selectedThemeMissing={selectedThemeMissing}
                busy={busy}
              />
            )}
            <s-paragraph>
              {fixableCount} finding{fixableCount === 1 ? "" : "s"} can be fixed by the app. Preparing reads your store and
              proposes exact changes; nothing is changed until you approve and confirm them on the review page.
            </s-paragraph>
            <s-text color="subdued">
              {ai.enabled
                ? `AI is on (${ai.model}). It drafts values and explains issues; you still review and approve every change.`
                : `AI is off: ${ai.reason}`}
            </s-text>
            {ai.enabled && (
              <label>
                <input type="checkbox" checked={aiDraft} onChange={(e) => setAiDraft(e.target.checked)} /> Also draft SEO and
                alt-text values with AI
              </label>
            )}
            <s-stack direction="inline" gap="small">
              <s-button
                variant="primary"
                onClick={() => submitTop({ intent: "prepareAll", aiDraft: ai.enabled && aiDraft ? "yes" : "no" }, { method: "post" })}
                {...flag("disabled", busy || fixableCount === 0)}
              >
                Prepare all fixable issues
              </s-button>
              {ai.enabled && (
                <s-button onClick={() => submitTop({ intent: "aiAssist" }, { method: "post" })} {...flag("disabled", busy)}>
                  Get AI help for all issues
                </s-button>
              )}
              <s-button href={`/app/audits/${audit.id}/review`} {...flag("disabled", planCounts.total === 0)}>
                Review and approve changes
              </s-button>
            </s-stack>
            {actionData?.manual?.length > 0 && !actionData.findingKey && (
              <s-banner tone="info" heading="Not prepared automatically">
                <s-unordered-list>
                  {actionData.manual.slice(0, 30).map((m, i) => (
                    <s-list-item key={i}>
                      {m.url ? `${m.url}: ` : ""}
                      {m.reason}
                    </s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            )}
          </s-stack>
        </s-section>
      )}

      {report.score && <ScoreAndPriorities score={report.score} findings={findings} />}

      <ReportDetails report={report} />

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
            <s-text color="subdued">
              {Object.entries(outcomeCounts)
                .map(([k, n]) => `${n} ${OUTCOME_SHORT[k]}`)
                .join(" · ")}
            </s-text>
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
        {!ai.enabled && (
          <s-box paddingBlockStart="base">
            <s-banner tone="info" heading="AI suggestions are off">
              {ai.reason}
            </s-banner>
          </s-box>
        )}
      </s-section>

      <s-section heading="Findings">
        <s-stack direction="inline" gap="base">
          {filterSelect("category", "Category", presentCategories.map((k) => [k, DISPLAY_CATEGORIES[k]]))}
          {filterSelect("severity", "Severity", SEVERITIES.map((s) => [s, s]))}
          {filterSelect("risk", "Risk", RISKS.map((r) => [r, r]))}
          {filterSelect("fixability", "Action class", Object.entries(ACTION_CLASSES))}
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
                    selectedTheme={selectedTheme}
                    actionData={actionData}
                    ai={ai}
                    analysis={analyses[f.key]}
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
