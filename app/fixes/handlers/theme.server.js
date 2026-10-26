// Theme file fixes. Separate from Admin API content updates:
//  - only unpublished / development themes are ever written (never MAIN);
//  - the original file is backed up before the write;
//  - the patch is recomputed from the freshly fetched file and must produce
//    exactly the content the merchant approved (same SHA-256);
//  - the asynchronous job is polled and the saved file is re-read and re-checked;
//  - themes are never published by this app.

import { VERIFY } from "../constants";
import { FixError, assertNoUserErrors, runGraphql } from "../graphql.server";
import { assertGid } from "../resolve.server";
import { THEME_PATCHES, headIncludes, lineDiff, sha256 } from "./themePatches.server";

export const WRITABLE_THEME_ROLES = ["UNPUBLISHED", "DEVELOPMENT"];

export const THEMES_QUERY = `#graphql
  query StoreAuditThemes {
    themes(first: 25, roles: [MAIN, UNPUBLISHED, DEVELOPMENT]) {
      nodes {
        id
        name
        role
        processing
        updatedAt
      }
    }
  }`;

export const THEME_FILE_QUERY = `#graphql
  query StoreAuditThemeFile($id: ID!, $filenames: [String!], $first: Int!) {
    theme(id: $id) {
      id
      name
      role
      processing
      files(filenames: $filenames, first: $first) {
        nodes {
          filename
          checksumMd5
          body {
            ... on OnlineStoreThemeFileBodyText {
              content
            }
          }
        }
      }
    }
  }`;

export const THEME_FILES_UPSERT = `#graphql
  mutation StoreAuditThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      job {
        id
        done
      }
      upsertedThemeFiles {
        filename
        checksumMd5
      }
      userErrors {
        filename
        code
        field
        message
      }
    }
  }`;

export const JOB_QUERY = `#graphql
  query StoreAuditJob($id: ID!) {
    job(id: $id) {
      id
      done
    }
  }`;

export async function listThemes(admin) {
  const data = await runGraphql(admin, THEMES_QUERY);
  return (data.themes?.nodes || []).map((t) => ({
    id: t.id,
    name: t.name,
    role: t.role,
    processing: t.processing,
    writable: WRITABLE_THEME_ROLES.includes(t.role),
  }));
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeThemeHandler(fixType) {
  const patch = THEME_PATCHES[fixType];

  async function fetchThemeFile(ctx, themeId) {
    assertGid("OnlineStoreTheme", themeId);
    const data = await runGraphql(ctx.admin, THEME_FILE_QUERY, {
      id: themeId,
      filenames: [patch.filename],
      first: 1,
    });
    const t = data.theme;
    if (!t) throw new FixError("NOT_FOUND", "Theme was not found in this store.");
    const file = t.files?.nodes?.[0];
    const content = file?.body?.content;
    if (typeof content !== "string") {
      throw new FixError("NOT_FOUND", `${patch.filename} was not found as a text file in theme "${t.name}".`);
    }
    return {
      themeId: t.id,
      themeName: t.name,
      role: t.role,
      processing: t.processing,
      filename: file.filename,
      checksumMd5: file.checksumMd5 ?? null,
      contentSha256: sha256(content),
      content,
    };
  }

  // Reads several files of a theme. Missing or non-text files map to null.
  async function fetchFiles(ctx, themeId, filenames) {
    if (!filenames.length) return {};
    const data = await runGraphql(ctx.admin, THEME_FILE_QUERY, { id: themeId, filenames, first: filenames.length });
    const out = Object.fromEntries(filenames.map((f) => [f, null]));
    for (const n of data.theme?.files?.nodes || []) {
      if (typeof n.body?.content === "string") out[n.filename] = n.body.content;
    }
    return out;
  }

  const uncertain = (msg) => new FixError("ROOT_CAUSE_UNCONFIRMED", msg);

  // Is the tag already produced by a file rendered in <head>? Follows render /
  // include / section references two levels deep. Anything that cannot be read or
  // resolved statically makes the root cause uncertain, so nothing is proposed.
  async function assertNotProvidedByIncludes(ctx, themeId, layoutContent) {
    const first = headIncludes(layoutContent);
    if (first.unsupported.length) {
      throw uncertain(`The theme's <head> uses ${first.unsupported.join(", ")}, whose output cannot be checked automatically. Review manually.`);
    }
    let pending = first.files;
    const seen = new Set();
    for (let depth = 0; depth < 2 && pending.length; depth++) {
      const batch = [...new Set(pending)].filter((f) => !seen.has(f)).slice(0, 20);
      batch.forEach((f) => seen.add(f));
      const files = await fetchFiles(ctx, themeId, batch);
      const next = [];
      for (const [name, content] of Object.entries(files)) {
        if (content === null) throw uncertain(`${name} is rendered in <head> but could not be read. Review manually.`);
        if (patch.marker.test(content)) {
          throw uncertain(`${name} (rendered in <head>) already contains ${patch.markerLabel}. Adding another would create a duplicate; the audit may be out of date or the tag conditional. Review manually.`);
        }
        const nested = headIncludes(content, { headOnly: false });
        if (nested.unsupported.length) {
          throw uncertain(`${name} uses ${nested.unsupported.join(", ")}, which cannot be checked automatically. Review manually.`);
        }
        next.push(...nested.files);
      }
      pending = next;
    }
    if (pending.some((f) => !seen.has(f))) throw uncertain("The theme nests snippets too deeply to check automatically. Review manually.");
  }

  // The audit ran against the live storefront. Confirm the published theme really
  // has this problem before patching a draft copy.
  async function assertLiveThemeHasProblem(ctx) {
    const live = (await listThemes(ctx.admin)).find((t) => t.role === "MAIN");
    if (!live) throw uncertain("Could not identify the published theme to confirm the audit finding.");
    const content = (await fetchFiles(ctx, live.id, [patch.filename]))[patch.filename];
    if (content === null) throw uncertain(`Could not read ${patch.filename} in the published theme to confirm the finding.`);
    if (patch.check(content)) {
      throw uncertain(`The published theme's ${patch.filename} already has this fix, so the audit finding comes from somewhere else or is out of date. Nothing to patch.`);
    }
    return { live, content };
  }

  function assertWritable(theme) {
    if (!WRITABLE_THEME_ROLES.includes(theme.role)) {
      throw new FixError(
        "LIVE_THEME",
        "Only unpublished or development themes can be edited. The app never edits or publishes the live theme.",
      );
    }
  }

  return {
    filename: patch.filename,
    summary: patch.summary,

    async prepare(ctx, target) {
      const current = await fetchThemeFile(ctx, target.themeId);
      assertWritable(current);
      const { live, content: liveContent } = await assertLiveThemeHasProblem(ctx);
      if (patch.marker) {
        await assertNotProvidedByIncludes(ctx, live.id, liveContent);
        await assertNotProvidedByIncludes(ctx, current.themeId, current.content);
      }
      const result = patch.apply(current.content);
      if (!result.ok) throw new FixError("PATCH_NOT_APPLICABLE", result.reason);
      return [
        {
          resourceType: "OnlineStoreTheme",
          resourceId: current.themeId,
          resourceLabel: `${current.themeName}: ${patch.filename}`,
          targetUrl: null,
          before: {
            themeId: current.themeId,
            themeName: current.themeName,
            role: current.role,
            filename: current.filename,
            checksumMd5: current.checksumMd5,
            contentSha256: current.contentSha256,
          },
          proposed: {
            value: sha256(result.content),
            summary: patch.summary,
            diff: lineDiff(current.content, result.content),
          },
        },
      ];
    },

    // Rollback: restore the file saved before this app wrote it, only if the file
    // still holds exactly what the app wrote and the theme is still unpublished.
    async prepareRestore(ctx, original, approved) {
      const current = await fetchThemeFile(ctx, original.resourceId);
      if (!WRITABLE_THEME_ROLES.includes(current.role)) {
        throw new FixError("ROLLBACK_BLOCKED", "This theme is now published. Restoring it would change your live store, so restore the file manually in the theme editor.");
      }
      if (current.contentSha256 !== approved.value) {
        throw new FixError("ROLLBACK_CONFLICT", `${current.filename} has changed since this app wrote it. Restoring the backup would overwrite those newer changes, so review it manually.`);
      }
      const backup = await ctx.db.themeFileBackup.findFirst({
        where: { shop: ctx.shop, executionId: original.id },
        orderBy: { createdAt: "asc" },
      });
      if (!backup) throw new FixError("BACKUP_NOT_FOUND", "No backup was recorded for this change.");
      return {
        resourceType: "OnlineStoreTheme",
        resourceId: current.themeId,
        resourceLabel: `${current.themeName}: ${current.filename} (restore)`,
        targetUrl: null,
        before: {
          themeId: current.themeId,
          themeName: current.themeName,
          role: current.role,
          filename: current.filename,
          checksumMd5: current.checksumMd5,
          contentSha256: current.contentSha256,
        },
        proposed: {
          value: backup.contentSha256,
          backupId: backup.id,
          summary: `Restore ${current.filename} from the backup taken before the original change.`,
          diff: lineDiff(current.content, backup.content),
        },
      };
    },

    fetchCurrent: (ctx, plan) => fetchThemeFile(ctx, plan.resourceId),
    beforeValue: (snapshot) => snapshot?.contentSha256 ?? null,
    isStale: (before, current) => before?.contentSha256 !== current?.contentSha256,
    // The approved "value" for a theme patch is the SHA-256 of the exact
    // patched file the merchant reviewed; it is not free-form input.
    validate(value, current, plan) {
      const proposed = JSON.parse(plan.proposedJson);
      return value === proposed.value
        ? { ok: true, value, errors: [], warnings: [] }
        : { ok: false, value: null, errors: ["The approved patch does not match the reviewed patch."], warnings: [] };
    },
    alreadyApplied: (current, approvedValue) => current?.contentSha256 === approvedValue,

    async apply(ctx, plan, approvedValue, current) {
      assertWritable(current);
      if (current.processing) {
        throw new FixError("THEME_BUSY", "The theme is still processing. Try again shortly.", { retryable: true });
      }
      let newContent;
      if (plan.rollbackOfId) {
        const proposed = JSON.parse(plan.proposedJson);
        const backup = await ctx.db.themeFileBackup.findFirst({ where: { id: proposed.backupId, shop: ctx.shop } });
        if (!backup || backup.themeId !== current.themeId || backup.filename !== current.filename) {
          throw new FixError("BACKUP_NOT_FOUND", "The backup for this theme file was not found.");
        }
        newContent = backup.content;
      } else {
        const result = patch.apply(current.content);
        if (!result.ok) throw new FixError("PATCH_NOT_APPLICABLE", result.reason);
        newContent = result.content;
      }
      if (sha256(newContent) !== approvedValue) {
        throw new FixError("PATCH_MISMATCH", "The change no longer produces the reviewed result. Review it again.");
      }
      await ctx.db.themeFileBackup.create({
        data: {
          shop: ctx.shop,
          executionId: plan.id,
          themeId: current.themeId,
          filename: current.filename,
          checksumMd5: current.checksumMd5,
          contentSha256: current.contentSha256,
          content: current.content,
        },
      });
      const data = await runGraphql(
        ctx.admin,
        THEME_FILES_UPSERT,
        {
          themeId: current.themeId,
          files: [{ filename: current.filename, body: { type: "TEXT", value: newContent } }],
        },
        { mutation: true },
      );
      const payload = data.themeFilesUpsert;
      if (!payload) throw new FixError("GRAPHQL_ERROR", "Shopify returned no mutation result.");
      try {
        assertNoUserErrors(payload.userErrors, "Theme file update");
      } catch (err) {
        if (err.code === "ACCESS_DENIED") {
          throw new FixError(
            "THEME_WRITE_DENIED",
            "Shopify denied the theme file write. Public apps need Shopify's theme modification exemption before they can edit theme files.",
          );
        }
        throw err;
      }
      const sleep = ctx.sleep || sleepDefault;
      let jobDone = payload.job ? payload.job.done : true;
      for (let i = 0; !jobDone && i < (ctx.jobPolls ?? 10); i++) {
        await sleep(1000);
        const j = await runGraphql(ctx.admin, JOB_QUERY, { id: payload.job.id });
        jobDone = Boolean(j.job?.done);
      }
      return {
        mutation: "themeFilesUpsert",
        jobId: payload.job?.id ?? null,
        jobDone,
        upserted: (payload.upsertedThemeFiles || []).map((f) => f.filename),
      };
    },

    async verify(ctx, plan, approvedValue, preApply, applyResult) {
      if (applyResult && applyResult.jobDone === false) {
        return {
          status: VERIFY.PENDING,
          details: { jobId: applyResult.jobId },
          message: "Shopify is still processing the theme update. Re-verify from Execution history.",
        };
      }
      const after = await fetchThemeFile(ctx, plan.resourceId);
      const saved = after.contentSha256 === approvedValue;
      // A restore is verified by content alone; a fix also re-runs its check.
      const detectorPasses = plan.rollbackOfId ? true : patch.check(after.content);
      if (saved && detectorPasses) {
        return {
          status: VERIFY.PASSED,
          details: { theme: after.themeName, role: after.role, filename: after.filename },
          message: `Saved file matches the approved patch on "${after.themeName}" (${after.role.toLowerCase()}). The live theme was not changed. Preview this theme to confirm it renders correctly before publishing it yourself.`,
        };
      }
      return {
        status: VERIFY.FAILED,
        details: { saved, detectorPasses },
        message: saved
          ? "The file was saved but the re-check of the fix did not pass."
          : "The saved theme file does not match the approved patch.",
      };
    },
  };
}
