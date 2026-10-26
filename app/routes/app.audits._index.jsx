import { useRef, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createImport } from "../fixes/service.server";
import { toActionError } from "../fixes/http.server";
import { MAX_IMPORT_BYTES, STORE_MATCH } from "../fixes/constants";
import { flag, fmtDate } from "../fixes/ui";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
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
  return { imports };
};

export const action = async ({ request }) => {
  const { admin, session, redirect } = await authenticate.admin(request);
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
    return redirect(`/app/audits/${imp.id}`);
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
  const { imports } = useLoaderData();
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

  const error = localError || (actionData && !actionData.ok ? actionData.error : null);

  return (
    <s-page heading="Audit results">
      <s-section heading="Import an audit result">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload the <s-text type="strong">approved-fixes.json</s-text> downloaded from your audit report, or the
            JSON file written by the audit tool&apos;s <s-text type="strong">--json</s-text> option. Importing only
            records the findings for review. Nothing in your store changes until you approve and confirm specific
            fixes.
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
                      <s-text color="subdued">{imp.fileName || imp.sourceFormat}</s-text>
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
