/* eslint-disable react/prop-types -- this project does not use PropTypes; props come from loaders */
import { useEffect, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CHANGE_SCOPES, EXEC } from "../fixes/constants";
import { readJsonField, toActionError } from "../fixes/http.server";
import { FIX_TYPES, eligibilityProblems } from "../fixes/registry.server";
import {
  approvePlans,
  batchToken,
  executePlans,
  loadImport,
  serializePlan,
  skipPlan,
  unapprovePlan,
} from "../fixes/service.server";
import { DiffView, PlanBadges, ValueText, beforeValueOf, flag, fmtDate, inputStyle } from "../fixes/ui";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const imp = await loadImport(db, session.shop, params.importId);
  if (!imp) throw new Response("Audit import not found", { status: 404 });
  const rows = await db.fixExecution.findMany({
    where: { shop: session.shop, importId: imp.id },
    orderBy: [{ findingKey: "asc" }, { createdAt: "asc" }],
  });
  const plans = rows.map((r) => {
    const def = FIX_TYPES[r.fixType];
    const problems = def ? eligibilityProblems(def, { session, importRecord: imp }) : ["Unsupported fix type."];
    const scope = def ? CHANGE_SCOPES[def.changeScope] : null;
    return {
      ...serializePlan(r),
      label: `${r.rollbackOfId ? "Restore: " : ""}${def?.label || r.fixType}`,
      changeScope: def?.changeScope ?? null,
      scopeLabel: scope?.label ?? null,
      impact: scope?.impact ?? null,
      field: def?.handler.field ? { label: def.handler.field.label, max: def.handler.field.max, idealMax: def.handler.field.idealMax } : null,
      summary: def?.handler.summary || null,
      problems,
    };
  });
  // Identifies the exact set of approved changes shown in the confirmation step.
  const approvedRows = rows.filter((r) => r.status === EXEC.APPROVED);
  return {
    audit: { id: imp.id, auditedHost: imp.auditedHost },
    shop: session.shop,
    plans,
    batchToken: approvedRows.length ? batchToken(approvedRows) : null,
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "approve") {
      const items = readJsonField(form, "items");
      if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "Select at least one change to approve." };
      // Only these fields are accepted; the server re-reads everything else.
      const str = (v) => (typeof v === "string" ? v : undefined);
      const clean = items
        .filter((i) => i && typeof i.planId === "string")
        .map((i) => ({
          planId: i.planId,
          value: str(i.value),
          seenBefore: i.seenBefore === null ? null : str(i.seenBefore),
          seenProposed: str(i.seenProposed),
        }));
      const results = await approvePlans({ db, admin, session, importId: params.importId, items: clean });
      const okCount = results.filter((r) => r.ok).length;
      return { ok: okCount === results.length, intent, results, message: `${okCount} of ${results.length} change(s) approved.` };
    }
    if (intent === "execute") {
      const ids = readJsonField(form, "planIds");
      if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "There are no approved changes to apply." };
      if (form.get("confirmed") !== "yes") return { ok: false, error: "Confirm the changes before applying them." };
      const token = form.get("batchToken");
      if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        return { ok: false, error: "Confirm the exact list of changes before applying them." };
      }
      const { results, sessionExpired } = await executePlans({
        db,
        admin,
        session,
        importId: params.importId,
        planIds: ids.filter((x) => typeof x === "string"),
        expectedBatchToken: token,
      });
      const applied = results.filter((r) => r.ok).length;
      return {
        ok: !sessionExpired && applied === results.length,
        intent,
        results,
        message: `${applied} of ${results.length} change(s) applied. See verification results below.`,
        ...(sessionExpired ? { error: "Your session expired. Reload the app; remaining changes are still approved." } : {}),
      };
    }
    if (intent === "unapprove" || intent === "skip") {
      const planId = String(form.get("planId") || "");
      if (intent === "unapprove") await unapprovePlan({ db, session, planId });
      else await skipPlan({ db, session, planId });
      return { ok: true, intent, message: intent === "skip" ? "Change skipped." : "Change returned to review." };
    }
    return { ok: false, error: "Unknown action." };
  } catch (err) {
    return toActionError(err);
  }
};

function ResultList({ results, plans }) {
  if (!results?.length) return null;
  const label = (id) => plans.find((p) => p.id === id)?.resourceLabel || id;
  return (
    <s-unordered-list>
      {results.map((r, i) => (
        <s-list-item key={i}>
          {label(r.planId)}: {r.ok ? "OK" : "Not done"}
          {r.message ? ` – ${r.message}` : ""}
          {r.warnings?.length ? ` (Warnings: ${r.warnings.join(" ")})` : ""}
        </s-list-item>
      ))}
    </s-unordered-list>
  );
}

export default function ReviewFixes() {
  const { audit, shop, plans, batchToken } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle";

  const review = plans.filter((p) => p.status === EXEC.NEEDS_REVIEW || p.status === EXEC.STALE);
  const approved = plans.filter((p) => p.status === EXEC.APPROVED);
  const applying = plans.filter((p) => p.status === EXEC.APPLYING);
  const done = plans.filter((p) => [EXEC.APPLIED, EXEC.FAILED, EXEC.SKIPPED].includes(p.status));

  const [values, setValues] = useState(() =>
    Object.fromEntries(review.map((p) => [p.id, p.proposed?.value ?? ""])),
  );
  const [selected, setSelected] = useState({});
  const [confirming, setConfirming] = useState(false);

  // Keep edited values for plans that are still in review after a reload.
  useEffect(() => {
    setValues((prev) => {
      const next = {};
      for (const p of review) next[p.id] = prev[p.id] ?? p.proposed?.value ?? "";
      return next;
    });
    setSelected((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => review.some((p) => p.id === id))));
    if (actionData?.intent === "execute") setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans]);

  // Theme patches and restores carry a server-generated value the merchant cannot edit.
  const serverValue = (p) => p.executionKind === "theme" || Boolean(p.rollbackOfId);
  const eligible = (p) =>
    p.problems.length === 0 &&
    !(serverValue(p) && p.status === EXEC.STALE) &&
    (serverValue(p) || String(values[p.id] || "").trim());
  const eligibleReview = review.filter(eligible);
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const allSelected = eligibleReview.length > 0 && eligibleReview.every((p) => selected[p.id]);

  // Each approval states exactly what the merchant saw, so the server can refuse
  // it if the change or the current value was updated in the meantime.
  const approveSelected = () => {
    const items = selectedIds.map((id) => {
      const p = plans.find((x) => x.id === id);
      return serverValue(p)
        ? { planId: id, seenProposed: p.proposed.value }
        : { planId: id, value: values[id], seenBefore: beforeValueOf(p) ?? null };
    });
    submit({ intent: "approve", items: JSON.stringify(items) }, { method: "post" });
  };
  const execute = () =>
    submit(
      { intent: "execute", confirmed: "yes", batchToken, planIds: JSON.stringify(approved.map((p) => p.id)) },
      { method: "post" },
    );
  const adminCount = approved.filter((p) => p.changeScope === "admin_shared").length;
  const themeCount = approved.length - adminCount;
  const simple = (intent, planId) => submit({ intent, planId }, { method: "post" });

  return (
    <s-page heading="Review and apply changes">
      <s-link slot="breadcrumb-actions" href={`/app/audits/${audit.id}`}>
        Fix issues
      </s-link>

      <s-stack direction="block" gap="base">
        {actionData?.error && <s-banner tone="critical" heading={actionData.error} />}
        {actionData?.message && (
          <s-banner tone={actionData.ok ? "success" : "warning"} heading={actionData.message}>
            <ResultList results={actionData.results} plans={plans} />
          </s-banner>
        )}
        {applying.length > 0 && (
          <s-banner tone="info" heading={`${applying.length} change(s) are being applied`}>
            Applying is disabled until they finish. Reload to see the result.
          </s-banner>
        )}
        {busy && navigation.formData?.get("intent") === "execute" && (
          <s-banner tone="info" heading={`Applying ${approved.length} change(s) and verifying each one…`}>
            <s-spinner accessibilityLabel="Applying changes" />
          </s-banner>
        )}
      </s-stack>

      <s-section heading={`1. Review proposed changes (${review.length})`}>
        {review.length === 0 ? (
          <s-paragraph>Nothing to review. Prepare fixes from the Fix issues page.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Check the current value and edit the proposed value for each change. Suggestions are based only on
              your existing product or collection data. Select the changes you want, then approve them. Nothing is
              changed in your store at this step.
            </s-paragraph>
            <label>
              <input
                type="checkbox"
                checked={allSelected}
                disabled={busy || eligibleReview.length === 0}
                onChange={(e) =>
                  setSelected(e.target.checked ? Object.fromEntries(eligibleReview.map((p) => [p.id, true])) : {})
                }
              />{" "}
              Select all eligible changes ({eligibleReview.length})
            </label>
            {review.map((p) => {
              const value = values[p.id] ?? "";
              const len = value.trim().length;
              return (
                <s-box key={p.id} padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.resourceLabel}`}
                        checked={Boolean(selected[p.id])}
                        disabled={busy || !eligible(p)}
                        onChange={(e) => setSelected((s) => ({ ...s, [p.id]: e.target.checked }))}
                      />
                      <s-text type="strong">{p.label}</s-text>
                      <s-text>{p.resourceLabel}</s-text>
                      <PlanBadges plan={p} />
                    </s-stack>
                    {p.targetUrl && <s-text color="subdued">Audited page: {p.targetUrl}</s-text>}
                    {p.impact && (
                      <s-banner tone={p.changeScope === "admin_shared" ? "warning" : "info"} heading={p.scopeLabel}>
                        {p.impact}
                      </s-banner>
                    )}
                    {p.errorMessage && <s-banner tone="warning" heading={p.errorMessage} />}
                    {p.problems.length > 0 && (
                      <s-banner tone="info" heading="Cannot be approved yet">
                        {p.problems.join(" ")}
                      </s-banner>
                    )}

                    {p.executionKind === "theme" ? (
                      <s-stack direction="block" gap="small">
                        <s-paragraph>
                          {p.summary} Target: theme &quot;{p.before.themeName}&quot; ({String(p.before.role).toLowerCase()}),
                          file {p.before.filename}. The live theme is never edited or published by this app.
                        </s-paragraph>
                        <DiffView diff={p.proposed.diff} />
                      </s-stack>
                    ) : (
                      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                        <s-box padding="small" background="subdued" borderRadius="base">
                          <s-stack direction="block" gap="small-200">
                            <s-text type="strong">Current {p.field?.label}</s-text>
                            <ValueText value={beforeValueOf(p)} />
                            {p.fixType === "product_image_alt" && p.before.imageUrl && (
                              <s-thumbnail src={p.before.imageUrl} alt={p.before.alt || ""} size="large" />
                            )}
                          </s-stack>
                        </s-box>
                        {p.rollbackOfId ? (
                          <s-stack direction="block" gap="small-200">
                            <s-text type="strong">Value to restore</s-text>
                            <ValueText value={p.proposed?.value} />
                            {p.proposed?.note && <s-text color="subdued">{p.proposed.note}</s-text>}
                          </s-stack>
                        ) : (
                        <s-stack direction="block" gap="small-200">
                          <label htmlFor={`v-${p.id}`}>
                            <s-text type="strong">Proposed {p.field?.label}</s-text>
                          </label>
                          <textarea
                            id={`v-${p.id}`}
                            rows={p.fixType.endsWith("_description") ? 4 : 2}
                            style={inputStyle}
                            value={value}
                            maxLength={p.field?.max}
                            disabled={busy}
                            onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))}
                          />
                          <s-text color={len > (p.field?.idealMax || Infinity) ? "base" : "subdued"}>
                            {len}/{p.field?.max} characters
                            {len > (p.field?.idealMax || Infinity) ? ` (over the recommended ${p.field.idealMax})` : ""}
                          </s-text>
                          {p.proposed?.note && <s-text color="subdued">{p.proposed.note}</s-text>}
                        </s-stack>
                        )}
                      </s-grid>
                    )}
                    <s-stack direction="inline" gap="small">
                      <s-button variant="tertiary" onClick={() => simple("skip", p.id)} {...flag("disabled", busy)}>
                        Skip this change
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-box>
              );
            })}
            <s-button variant="primary" onClick={approveSelected} {...flag("disabled", busy || selectedIds.length === 0)}>
              {`Approve selected (${selectedIds.length})`}
            </s-button>
          </s-stack>
        )}
      </s-section>

      <s-section heading={`2. Confirm and apply (${approved.length})`}>
        {approved.length === 0 ? (
          <s-paragraph>No approved changes waiting.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-table>
              <s-table-header-row>
                <s-table-header>Change</s-table-header>
                <s-table-header>Resource</s-table-header>
                <s-table-header>Before</s-table-header>
                <s-table-header>After</s-table-header>
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {approved.map((p) => (
                  <s-table-row key={p.id}>
                    <s-table-cell>{p.label}</s-table-cell>
                    <s-table-cell>{p.resourceLabel}</s-table-cell>
                    <s-table-cell>
                      {p.executionKind === "theme" ? `${p.before.filename} (current)` : <ValueText value={beforeValueOf(p)} />}
                    </s-table-cell>
                    <s-table-cell>
                      {p.executionKind === "theme" ? p.summary : <ValueText value={p.approved?.value} />}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button variant="tertiary" onClick={() => simple("unapprove", p.id)} {...flag("disabled", busy)}>
                        Back to review
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {!confirming ? (
              <s-button variant="primary" onClick={() => setConfirming(true)} {...flag("disabled", busy || applying.length > 0)}>
                {`Apply ${approved.length} approved change(s)`}
              </s-button>
            ) : (
              <s-banner tone="warning" heading={`Apply ${approved.length} change(s) to ${shop}?`}>
                <s-stack direction="block" gap="small">
                  {adminCount > 0 && (
                    <s-paragraph>
                      <s-text type="strong">{adminCount} change(s) to Shopify Admin data: </s-text>
                      {CHANGE_SCOPES.admin_shared.impact}
                    </s-paragraph>
                  )}
                  {themeCount > 0 && (
                    <s-paragraph>
                      <s-text type="strong">{themeCount} change(s) to unpublished theme files: </s-text>
                      {CHANGE_SCOPES.theme_unpublished.impact}
                    </s-paragraph>
                  )}
                  <s-paragraph>
                    You are confirming exactly the {approved.length} change(s) listed above. If any of them is changed
                    or re-approved before this runs, nothing is applied and you will be asked to review again. Each
                    change is re-checked against the current value in Shopify before it is sent, and verified after.
                  </s-paragraph>
                  <s-stack direction="inline" gap="small">
                    <s-button variant="primary" tone="critical" onClick={execute} {...flag("loading", busy)} {...flag("disabled", busy)}>
                      Confirm and apply
                    </s-button>
                    <s-button onClick={() => setConfirming(false)} {...flag("disabled", busy)}>
                      Cancel
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-banner>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section heading={`3. Results for this audit (${done.length})`}>
        {done.length === 0 ? (
          <s-paragraph>No changes applied yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            {done.map((p) => (
              <s-box key={p.id} padding="small" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-200">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text type="strong">{p.label}</s-text>
                    <s-text>{p.resourceLabel}</s-text>
                    <PlanBadges plan={p} />
                    <s-text color="subdued">{fmtDate(p.appliedAt || p.updatedAt)}</s-text>
                  </s-stack>
                  {p.verification?.message && <s-text>{p.verification.message}</s-text>}
                  {p.errorMessage && <s-text tone="critical">{p.errorMessage}</s-text>}
                </s-stack>
              </s-box>
            ))}
            <s-link href="/app/history">Open execution history</s-link>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
