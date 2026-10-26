import { useActionData, useLoaderData, useNavigation, useSearchParams, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { EXEC, EXEC_LABELS, VERIFY } from "../fixes/constants";
import { toActionError } from "../fixes/http.server";
import { liveCheckPlan } from "../fixes/liveCheck.server";
import { CHANGE_SCOPES, FIX_TYPES } from "../fixes/registry.server";
import { prepareRollback, retryPlan, reverifyPlan, reversibility, serializePlan } from "../fixes/service.server";
import { PlanBadges, ValueText, beforeValueOf, flag, fmtDate, inputStyle } from "../fixes/ui";

const FILTERS = {
  all: { label: "All", where: {} },
  applied: { label: "Applied", where: { status: EXEC.APPLIED } },
  verified: { label: "Verification passed", where: { verificationStatus: VERIFY.PASSED } },
  verifyFailed: { label: "Verification failed", where: { verificationStatus: VERIFY.FAILED } },
  failed: { label: "Failed", where: { status: EXEC.FAILED } },
  stale: { label: "Changed since review", where: { status: EXEC.STALE } },
  skipped: { label: "Skipped", where: { status: EXEC.SKIPPED } },
};
const STUCK_MS = 10 * 60 * 1000;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const key = Object.prototype.hasOwnProperty.call(FILTERS, url.searchParams.get("filter")) ? url.searchParams.get("filter") : "all";
  const rows = await db.fixExecution.findMany({
    where: { shop: session.shop, status: { not: EXEC.NEEDS_REVIEW }, ...FILTERS[key].where },
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: { import: { select: { auditedHost: true } } },
  });
  const now = Date.now();
  // Which applied changes have a theme backup, and which already have a restore in progress.
  const ids = rows.map((r) => r.id);
  const backups = new Set(
    (await db.themeFileBackup.findMany({ where: { shop: session.shop, executionId: { in: ids } }, select: { executionId: true } })).map((b) => b.executionId),
  );
  const activeRollbacks = new Set(
    (
      await db.fixExecution.findMany({
        where: { shop: session.shop, rollbackOfId: { in: ids }, status: { in: [EXEC.NEEDS_REVIEW, EXEC.APPROVED, EXEC.APPLYING, EXEC.APPLIED] } },
        select: { rollbackOfId: true },
      })
    ).map((r) => r.rollbackOfId),
  );
  return {
    filter: key,
    plans: rows.map((r) => {
      const p = serializePlan(r);
      const stuck = r.status === EXEC.APPLYING && now - new Date(r.updatedAt).getTime() > STUCK_MS;
      return {
        ...p,
        auditedHost: r.import?.auditedHost,
        label: `${r.rollbackOfId ? "Restore: " : ""}${FIX_TYPES[r.fixType]?.label || r.fixType}`,
        scopeLabel: CHANGE_SCOPES[FIX_TYPES[r.fixType]?.changeScope]?.label ?? null,
        reversibility: reversibility(r, { hasBackup: backups.has(r.id) }),
        rolledBack: activeRollbacks.has(r.id),
        canRetry:
          r.status === EXEC.FAILED ||
          r.status === EXEC.STALE ||
          stuck ||
          (r.status === EXEC.APPLIED && [VERIFY.FAILED, VERIFY.UNAVAILABLE].includes(r.verificationStatus)),
        canReverify: r.status === EXEC.APPLIED && r.verificationStatus !== VERIFY.PASSED,
        canLiveCheck: r.status === EXEC.APPLIED && r.executionKind === "admin_api" && r.fixType.includes("_seo_"),
      };
    }),
  };
};

export const action = async ({ request }) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const planId = String(form.get("planId") || "");
  try {
    if (intent === "retry") {
      const importId = await retryPlan({ db, admin, session, planId });
      return redirect(`/app/audits/${importId}/review`);
    }
    if (intent === "rollback") {
      // Creates a restore as a new change; nothing is written until it is approved and confirmed.
      const r = await prepareRollback({ db, admin, session, planId });
      return redirect(`/app/audits/${r.importId}/review`);
    }
    if (intent === "reverify") {
      const v = await reverifyPlan({ db, admin, session, planId });
      return { ok: true, message: v.message };
    }
    if (intent === "liveCheck") {
      const r = await liveCheckPlan({ db, admin, session, planId });
      return { ok: true, message: r.message };
    }
    return { ok: false, error: "Unknown action." };
  } catch (err) {
    return toActionError(err);
  }
};

function afterValue(p) {
  if (p.executionKind === "theme") return p.proposed?.summary;
  return p.approved?.value ?? p.proposed?.value;
}

export default function ExecutionHistory() {
  const { plans, filter } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [, setSearchParams] = useSearchParams();
  const busy = navigation.state !== "idle";
  const act = (intent, planId) => submit({ intent, planId }, { method: "post" });

  return (
    <s-page heading="Execution history">
      <s-stack direction="block" gap="base">
        {actionData?.error && <s-banner tone="critical" heading={actionData.error} />}
        {actionData?.message && <s-banner tone="success" heading={actionData.message} />}
      </s-stack>
      <s-section>
        <s-stack direction="block" gap="base">
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <s-text>Show</s-text>
            <select
              style={{ ...inputStyle, width: "auto" }}
              value={filter}
              onChange={(e) => setSearchParams(e.target.value === "all" ? {} : { filter: e.target.value })}
            >
              {Object.entries(FILTERS).map(([k, f]) => (
                <option key={k} value={k}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <s-paragraph>
            Retry never re-sends a change directly. It reads the current value from Shopify again and returns the
            change to review, so you approve and confirm it again.
          </s-paragraph>
          {plans.length === 0 ? (
            <s-paragraph>No changes recorded yet.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header>Change</s-table-header>
                <s-table-header>Before</s-table-header>
                <s-table-header>After</s-table-header>
                <s-table-header>Result</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {plans.map((p) => (
                  <s-table-row key={p.id}>
                    <s-table-cell>{fmtDate(p.appliedAt || p.updatedAt)}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-300">
                        <s-text type="strong">{p.label}</s-text>
                        <s-text>{p.resourceLabel}</s-text>
                        <s-text color="subdued">
                          {p.auditedHost} · attempt {p.attempts}
                        </s-text>
                        {p.scopeLabel && <s-badge tone={p.executionKind === "theme" ? "neutral" : "warning"}>{p.scopeLabel}</s-badge>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {p.executionKind === "theme" ? `${p.before.filename} on ${p.before.themeName}` : <ValueText value={beforeValueOf(p)} />}
                    </s-table-cell>
                    <s-table-cell>
                      <ValueText value={afterValue(p)} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-300">
                        <PlanBadges plan={p} />
                        {p.status === EXEC.SKIPPED && <s-text color="subdued">{EXEC_LABELS.SKIPPED} by you</s-text>}
                        {p.verification?.message && <s-text>{p.verification.message}</s-text>}
                        {p.liveCheck?.message && (
                          <s-text color="subdued">
                            Storefront ({fmtDate(p.liveCheck.checkedAt)}): {p.liveCheck.message}
                          </s-text>
                        )}
                        {p.errorMessage && <s-text tone="critical">{p.errorMessage}</s-text>}
                        {p.reversibility && (
                          <s-text color="subdued">
                            {p.reversibility.reversible ? "Reversible: " : "Not automatically reversible: "}
                            {p.reversibility.reason}
                          </s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-200">
                        {p.canRetry && (
                          <s-button variant="secondary" onClick={() => act("retry", p.id)} {...flag("disabled", busy)}>
                            Retry (review again)
                          </s-button>
                        )}
                        {p.reversibility?.reversible && !p.rolledBack && (
                          <s-button variant="secondary" onClick={() => act("rollback", p.id)} {...flag("disabled", busy)}>
                            Prepare rollback (review first)
                          </s-button>
                        )}
                        {p.rolledBack && <s-text color="subdued">Restore prepared or applied</s-text>}
                        {p.canReverify && (
                          <s-button variant="tertiary" onClick={() => act("reverify", p.id)} {...flag("disabled", busy)}>
                            Re-verify
                          </s-button>
                        )}
                        {p.canLiveCheck && (
                          <s-button variant="tertiary" onClick={() => act("liveCheck", p.id)} {...flag("disabled", busy)}>
                            Check storefront
                          </s-button>
                        )}
                        <s-link href={`/app/audits/${p.importId}`}>Open audit</s-link>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
