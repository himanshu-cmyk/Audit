import { useRef, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createImport, createInAppAudit } from "../fixes/service.server";
import { FixError } from "../fixes/graphql.server";
import { listThemes } from "../fixes/handlers/theme.server";
import { toActionError } from "../fixes/http.server";
import { MAX_IMPORT_BYTES, STORE_MATCH } from "../fixes/constants";
import { flag, fmtDate, inputStyle } from "../fixes/ui";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  let themes = [];
  try {
    themes = (await listThemes(admin)).filter((t) => t.writable);
  } catch (err) {
    if (!(err instanceof FixError)) throw err;
  }
  const imports = await db.auditImport.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      fileName: true,
      sourceFormat: true,
      auditedHost: true,
      auditDate: true,
      overallScore: true,
      grade: true,
      findingCount: true,
      storeMatch: true,
      storeConfirmedAt: true,
      createdAt: true,
      _count: { select: { fixes: true } },
    },
  });
  return { imports, themes };
};

export const action = async ({ request }) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  if (new URL(request.url).searchParams.get("run") === "1") {
    // Runs the in-app audit. It only reads the store.
    const form = await request.formData();
    try {
      const themeId = form.get("themeId");
      const imp = await createInAppAudit({
        db,
        admin,
        session,
        includeStorefront: form.get("includeStorefront") === "yes",
        storefrontPassword: typeof form.get("storefrontPassword") === "string" ? form.get("storefrontPassword") : null,
        themeId: typeof themeId === "string" && themeId ? themeId : null,
      });
      return redirect(`/app/audits/${imp.id}`);
    } catch (err) {
      return { ...toActionError(err), source: "run" };
    }
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_IMPORT_BYTES + 64 * 1024) {
    return { ok: false, error: "The file is larger than the 5 MB limit." };
  }
  const form = await request.formData();
  const file = form.get("auditFile");
  if (!file || typeof file === "string") {
    return { ok: false, error: "Choose a JSON file to upload." };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return { ok: false, error: "The file is larger than the 5 MB limit." };
  }
  try {
    // Importing only records and validates the findings. It never changes the store.
    const imp = await createImport({ db, admin, session, text: await file.text(), fileName: file.name });
    // Identical content already imported in this shop: open that import instead.
    return redirect(`/app/audits/${imp.id}${imp.duplicate ? "?existing=1" : ""}`);
  } catch (err) {
    return toActionError(err);
  }
};

function matchBadge(imp) {
  if (imp.storeMatch === STORE_MATCH.MATCHED) return <s-badge tone="success">Store matched</s-badge>;
  if (imp.storeMatch === STORE_MATCH.MISMATCH && imp.storeConfirmedAt) {
    return <s-badge tone="info">Store confirmed</s-badge>;
  }
  if (imp.storeMatch === STORE_MATCH.MISMATCH) return <s-badge tone="warning">Domain mismatch</s-badge>;
  return <s-badge tone="neutral">Review only</s-badge>;
}

export default function AuditResults() {
  const { imports, themes } = useLoaderData();
  const [themeId, setThemeId] = useState(themes[0]?.id || "");
  const [includeStorefront, setIncludeStorefront] = useState(true);
  const [storefrontPassword, setStorefrontPassword] = useState("");
  const runAudit = () =>
    submit(
      { themeId, includeStorefront: includeStorefront ? "yes" : "no", storefrontPassword: includeStorefront ? storefrontPassword : "" },
      { method: "post", action: "?index&run=1" },
    );
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState("");
  const [localError, setLocalError] = useState(null);
  const uploading = navigation.state === "submitting";

  const upload = () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setLocalError("Choose a JSON file to upload.");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setLocalError("The file is larger than the 5 MB limit.");
      return;
    }
    setLocalError(null);
    const fd = new FormData();
    fd.append("auditFile", file);
    submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const error = localError || (actionData && !actionData.ok && actionData.source !== "run" ? actionData.error : null);

  return (
    <s-page heading="Audit results">
      <s-section heading="Audit this store">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The app checks your products, collections and product images in Shopify Admin, your published
            theme, and (optionally) a few public storefront pages. The audit only reads your store; nothing
            changes until you review, approve and confirm specific fixes.
          </s-paragraph>
          {actionData?.source === "run" && actionData.error && <s-banner tone="critical" heading={actionData.error} />}
          <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 420 }}>
            <s-text type="strong">Theme to apply theme fixes to</s-text>
            <select style={inputStyle} value={themeId} onChange={(e) => setThemeId(e.target.value)}>
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.role.toLowerCase()})
                </option>
              ))}
              <option value="">Decide later</option>
            </select>
            <s-text color="subdued">
              {themes.length
                ? "Only unpublished or development themes are listed. The live theme is never edited; Admin fixes (SEO, alt text) do not depend on this choice."
                : "No unpublished theme found. Duplicate your live theme in Online Store > Themes to get theme fixes; Admin fixes work without it."}
            </s-text>
          </label>
          <label>
            <input type="checkbox" checked={includeStorefront} onChange={(e) => setIncludeStorefront(e.target.checked)} /> Also check
            public storefront pages
          </label>
          {includeStorefront && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 420 }}>
              <s-text type="strong">Storefront password (only if your store is password protected)</s-text>
              <input
                type="password"
                autoComplete="off"
                style={inputStyle}
                value={storefrontPassword}
                onChange={(e) => setStorefrontPassword(e.target.value)}
              />
              <s-text color="subdued">
                Used for this audit only to open your storefront pages. It is never saved. Find it in Online Store &gt;
                Preferences &gt; Password protection.
              </s-text>
            </label>
          )}
          <s-button variant="primary" onClick={runAudit} {...flag("loading", navigation.state === "submitting")}>
            Run audit now
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Import a report file (optional)">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload the JSON report written by the audit tool (<s-text type="strong">schemaVersion 1</s-text>). Older
            --json output and the report&apos;s approved-fixes.json are accepted as legacy formats. Importing only
            records the findings for review: selections or flags in the file are never treated as approval, and nothing
            in your store changes until you approve and confirm specific fixes here.
          </s-paragraph>
          {error && (
            <s-banner tone="critical" heading={error}>
              {actionData?.details?.length > 0 && !localError && (
                <s-unordered-list>
                  {actionData.details.map((d, i) => (
                    <s-list-item key={i}>{d}</s-list-item>
                  ))}
                </s-unordered-list>
              )}
            </s-banner>
          )}
          <s-stack direction="inline" gap="base" alignItems="center">
            <label htmlFor="auditFile">
              <s-text type="strong">Audit file (.json, up to 5 MB)</s-text>
            </label>
            <input
              id="auditFile"
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={(e) => setFileName(e.target.files?.[0]?.name || "")}
            />
            <s-button variant="primary" onClick={upload} {...flag("loading", uploading)} {...flag("disabled", !fileName)}>
              Import and preview
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Imported audits">
        {imports.length === 0 ? (
          <s-paragraph>No audits imported yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Audited store</s-table-header>
              <s-table-header>Audit date</s-table-header>
              <s-table-header>Score</s-table-header>
              <s-table-header>Findings</s-table-header>
              <s-table-header>Store</s-table-header>
              <s-table-header>Imported</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {imports.map((imp) => (
                <s-table-row key={imp.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-300">
                      <s-text type="strong">{imp.auditedHost || "Unknown domain"}</s-text>
                      <s-text color="subdued">{imp.sourceFormat === "in-app" ? "Audit run by this app" : imp.fileName || imp.sourceFormat}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{fmtDate(imp.auditDate)}</s-table-cell>
                  <s-table-cell>
                    {imp.overallScore != null ? `${imp.overallScore}/100${imp.grade ? ` (${imp.grade})` : ""}` : "—"}
                  </s-table-cell>
                  <s-table-cell>{imp.findingCount}</s-table-cell>
                  <s-table-cell>{matchBadge(imp)}</s-table-cell>
                  <s-table-cell>{fmtDate(imp.createdAt)}</s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/audits/${imp.id}`}>Open</s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
