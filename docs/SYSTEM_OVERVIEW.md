# Store Audit app: system overview (October 2026)

This app is an embedded Shopify app. It audits a merchant's own store and fixes a small, allowlisted
set of issues, and only after the merchant approves each change. Optional AI drafts suggestions but
can never change the store.

## Stack

- **Framework:** Shopify app template on React Router 7 (`@shopify/shopify-app-react-router`). The
  routes are file-based in `app/routes/`.
- **UI:** Polaris web components (`<s-page>`, `<s-section>`, `<s-button>` and so on), rendered in
  the Shopify admin.
- **Admin API:** GraphQL, version **2026-07** (`ApiVersion.July26` in `app/shopify.server.js`).
- **Authentication:** `authenticate.admin(request)` provides `admin`, `session` and `redirect`.
  Every database read and write is scoped to `session.shop`.
- **Database:** Prisma with SQLite (`prisma/dev.sqlite`). Migrations are in `prisma/migrations/`
  and are all additive.
- **Tests:** Vitest. A fake in-memory Shopify Admin API lives in `test/helpers/fakeShopify.js`, and
  tests have no network access (`test/setup.js`).
- **Hosting:** Render (`https://audit-fvfo.onrender.com`).
- **App config:** `shopify.app.toml`. The app is configured for App Store distribution.

## Access scopes (shopify.app.toml)

| Scope | Used for |
|---|---|
| `write_products` (implies read) | product and collection SEO fixes; scanning products and collections |
| `read_files`, `write_files` | product image alt text through `fileUpdate` |
| `read_themes`, `write_themes` | reading theme files for the audit; theme patches (writes are disabled, see below) |
| `write_metaobjects`, `write_metaobject_definitions` | from the template; not used by the audit |
| `read_legal_policies` | checking store policies (read only) |
| `read_online_store_pages`, `read_content` | page and blog-post SEO, contact page (read only) |
| `read_online_store_navigation` | broken menu links (read only) |

The last four were added recently. A store has to approve them again (re-run `npm run dev`, or
deploy the config). Until it does, those checks report "not checked".

## Main user flow

1. **Audit results** (`/app/audits`, `app/routes/app.audits._index.jsx`):
   - The merchant clicks **Run audit now**.
   - Optional inputs on the run form:
     - the theme to use for theme fixes (unpublished or development themes only)
     - whether to also check storefront pages
     - the storefront password, if the store is password protected (used for that run only, never
       saved)
   - A secondary option imports a JSON report from the old external Node.js audit tool (legacy).
2. **Fix issues** (`/app/audits/:id`, `app/routes/app.audits.$importId.jsx`), from top to bottom:
   - A warning banner listing what could not be checked and why.
   - **Fix this store:**
     - the theme to fix, chosen once per audit
     - **Prepare all fixable issues**, with an optional "draft values with AI" checkbox
     - **Get AI help for all issues**
   - Score, category scores and a "What to fix first" list.
   - Report details: source, coverage, limitations.
   - Filterable findings. Each finding card shows details, evidence, recommendation, its action
     class, its prepared changes, and "Explain with AI".
3. **Review and apply** (`/app/audits/:id/review`, `app/routes/app.audits.$importId_.review.jsx`):
   - For each change, the merchant sees the current value and the proposed value, which is
     editable.
   - Actions on each change:
     - "Get AI suggestion" (and "Get AI suggestions for all")
     - "Use this suggestion"
     - Approve
     - Reject
     - "Mark for manual review"
   - The merchant then confirms the exact batch, and the changes are applied and verified.
4. **Execution history** (`/app/history`, `app/routes/app.history.jsx`):
   - Lists every change with before and after values, its status, verification and where the value
     came from.
   - Actions: retry (which reconciles first), re-verify, storefront re-check, and rollback (which
     creates a new reviewable change).

## Folder map

```
app/audit/engine.server.js     In-app audit: Admin scans, theme checks, storefront HTML checks, score, coverage
app/audit/html.server.js       Tiny HTML tag scanner and static accessibility rules (no dependencies)
app/fixes/registry.server.js   ALLOWLIST of fix types (the only things the app may change) and finding classification
app/fixes/service.server.js    Import, audit run, prepare, approve, execute, retry/reconcile, rollback, theme selection
app/fixes/handlers/seo.server.js       Product/collection SEO title + description (productUpdate / collectionUpdate)
app/fixes/handlers/imageAlt.server.js  Product media alt text (fileUpdate)
app/fixes/handlers/theme.server.js     Theme patches (themeFilesUpsert); preview-only while disabled
app/fixes/handlers/themePatches.server.js  Fixed patch templates: html lang, canonical tag
app/fixes/importer.server.js   Validates uploaded report files (schemaVersion 1 + 2 legacy formats)
app/fixes/reportContract.server.js  Structural limits, digests, stable finding ids, known issue ids, limitations text
app/fixes/resolve.server.js    Storefront URL -> product/collection handle -> Admin lookup (exact handle match)
app/fixes/safeFetch.server.js  SSRF-safe HTTPS GET/POST (allowlisted host, public IPs only, size/time limits)
app/fixes/liveCheck.server.js  Optional storefront re-check after an SEO fix
app/fixes/storeMatch.server.js Shop identity and report-to-store matching
app/fixes/constants.js         Shared statuses, labels, categories (client + server)
app/fixes/ui.jsx               Shared UI pieces (badges, diff view, AI panel)
app/ai/*                       Gemini provider, prompts, response schema + validator, suggestion service
scripts/dry-run.js             End-to-end dry run against the fake Admin API (never a real store)
```

## Data model (prisma/schema.prisma)

- **Session:** Shopify sessions, from the template.
- **AuditImport:** one audit, either run in the app or imported from a file. Its fields:
  - `shop`, `sourceFormat` (`in-app`, `node-report-v1`, `audit-json` legacy, `approved-fixes`
    legacy) and `findingsJson` (the normalised findings)
  - `reportJson`: scan counts, theme, policies, setup, content, storefront status, `score` and
    `coverage`
  - `overallScore`, `grade`, and `storeMatch` (`MATCHED`, `MISMATCH` or `UNKNOWN`)
  - `contractVersion`, `rawSha256`, `contentDigest` (unique per shop, which makes re-imports
    idempotent)
  - `themeId`, the theme chosen for theme fixes
- **FixExecution:** one reviewable change to one resource field. Its fields:
  - the target: `fixType`, `resourceType`, `resourceId` and `parentResourceId`
  - the values: `beforeJson`, `proposedJson`, and `approvedJson` (value, before-state, approval
    hash, revision, and the source of the value)
  - the state: `status`, `verificationStatus`, and `revision` (incremented on every
    review-relevant change)
  - `rollbackOfId`, and `dedupeKey`, which is unique per shop
- **ThemeFileBackup:** the original theme file content, saved before any theme write.
- **AiSuggestion:** advisory AI output with `kind` (`value` or `analysis`), `status` (`VALID`,
  `INVALID` or `ERROR`), the output and validation errors, provider and model. It is never executed.

## What the in-app audit checks

All of these checks only read the store. Limits: 250 active products, 100 collections, 100 pages,
100 articles, 6 storefront pages and 20 internal links.

- **Shopify Admin data:**
  - Product and collection SEO: title length (15–60), meta description missing or long/short
    (50–165).
  - Product media with weak or empty alt text.
  - Products with no images, fewer than 30 words of description, or every variant priced 0.
  - Empty collections, and collection images without alt text.
  - Duplicate SEO titles or descriptions.
  - Store password protection on.
  - No custom domain.
  - Empty legal policies (privacy, refund, terms, shipping).
  - Page and blog-post SEO (from the `global.title_tag` and `global.description_tag` metafields).
  - No contact page.
  - Menu items pointing to deleted products, collections or pages.
  - Product counts (all, active, draft), to explain an empty scan.
- **Published theme files:**
  - `<html lang>`.
  - The canonical tag.
  - Open Graph tags.
  - Product structured data (follows `templates/product.json` to its sections and snippets).
  - The favicon (`config/settings_data.json`).
  - Five or more unused themes.
  - Anything that cannot be resolved is reported as "not checked", never as an issue.
- **Storefront HTML (optional),** fetched through `safeFetch` from the shop's own domain only:
  - Page checks: title, H1 count, `<img>` without alt, Open Graph, JSON-LD, render-blocking
    scripts, third-party script hosts and `http://` resources.
  - Homepage title and meta description.
  - Static accessibility rules: `label`, `autocomplete-valid`, `link-name`, `button-name`,
    `landmark-one-main` and `duplicate-id`.
  - Broken internal links.
  - Password-protected stores are unlocked with the password typed for the run. The app posts the
    form's hidden fields (including `authenticity_token`), with cookies, Origin and Referer.
  - Shopify's bot protection may answer HTTP 403 or 429. That is reported as "blocked", not as a
    wrong password.
- **Storefront request management** (`app/audit/storefrontClient.server.js`):
  - Requests run one at a time, with a budget of 40 per audit and a per-audit cache.
  - Only 429 and 503 are retried, at most twice, honouring `Retry-After` (10 seconds or less) or
    using capped backoff with jitter.
  - The app stops at a final 429 (`rate_limited`) or a 403 (`blocked`).
  - Only 404 and 410 count as broken links.
- **Speed, rendered accessibility and console errors** (`app/audit/pagespeed.server.js`):
  - Measured with Google PageSpeed Insights on the homepage when `PAGESPEED_API_KEY` is set.
  - Lab and field data are kept separate.
  - Not measured for password-protected stores.
  - Without a key, these show as `not_measured`.
- **Coverage statuses:** `checked`, `partial`, `not_checked`, `rate_limited`, `blocked`,
  `error` and `not_measured`. Only `checked` and `partial` categories are scored.
- **Granted scopes** are read from Shopify (`currentAppInstallation.accessScopes`), with the
  session scopes as the fallback.
- **Score:**
  - Each checked category starts at 100 and loses 25, 15, 8 or 3 points per critical, high, medium
    or low finding (minimum 0). The overall score is the average of the checked categories.
  - Unchecked categories show "Not checked" and are left out.
  - The categories are SEO, Accessibility, Speed and code, Links, Shopify setup and Trust.

Findings use stable issue ids (for example `seo.meta-description.missing`, `catalog.product.no-images`,
`a11y.label` and `links.menu-broken`). There is one finding per issue id, which collects every
affected URL and evidence line.

## Finding classification (registry.server.js)

Each finding falls into one of five action classes:

| Class | Meaning |
|---|---|
| `admin_api` | The app can fix it through an allowlisted Admin mutation, after checking the root cause and getting approval |
| `needs_evidence` | It's related, but the cause is unconfirmed (for example, alt text reported by the external tool) |
| `theme_patch` | Fixed theme patch, preview only while theme writes are disabled |
| `manual` | Known issue with no safe automatic fix; guidance only |
| `unsupported` | Unknown issue id or conflicting duplicate |

### Allowlisted fix types

| Fix type | What it changes | Mutation |
|---|---|---|
| Product SEO title / description | `Product.seo` | `productUpdate(product:{id, seo})` |
| Collection SEO title / description | `Collection.seo` | `collectionUpdate(collection:{id, seo})` |
| Product image alt text | `MediaImage.alt`, READY media of that product only | `fileUpdate` |
| Theme: `html lang` | `layout/theme.liquid` on an unpublished theme | `themeFilesUpsert` (disabled) |
| Theme: canonical tag | `layout/theme.liquid` on an unpublished theme | `themeFilesUpsert` (disabled) |

Nothing else can be changed. These are fixed manually: homepage SEO, pages, blogs, menus,
policies, favicon, images and catalog data. The app never touches prices, inventory, status,
orders or customers.

## Change lifecycle and safety rules

- **Statuses:** `NEEDS_REVIEW` (Awaiting Approval), `APPROVED`, `APPLYING` (Executing), `APPLIED`
  (labelled Completed only after verification passes), `FAILED`, `SKIPPED` (Rejected), `STALE`
  (Conflict Detected) and `MANUAL_REVIEW`. Verification is tracked separately: `PASSED`, `FAILED`,
  `PENDING` and so on.
- **Prepare:**
  1. Re-read the resource through the Admin API.
  2. Check that the finding's root cause really is in Admin data. For example, a missing meta
     description on a product that already has description text is a theme issue, so it becomes
     manual.
  3. Propose a value from the store's own data.
- **Approve:**
  - The merchant must send the revision they reviewed, plus the before-value they saw (or, for
    server-generated patches, the exact proposed value).
  - The server re-validates the value: no HTML, Liquid or links, and within length limits.
  - The approval hash is an HMAC (`SHOPIFY_API_SECRET`) over the shop, revision, finding, resource,
    fix type, value and before-state.
- **Execute:**
  1. Confirm the batch token for the exact set of approvals shown.
  2. Claim the change atomically (`APPROVED` to `APPLYING`).
  3. Re-check the hash and revision, scopes, and eligibility.
  4. Re-read the current value. If it changed, mark the change `STALE`; nothing is sent.
  5. Send one fixed mutation.
  6. Check `userErrors`.
  7. Read the value back to verify it, and check that unrelated fields did not change.
- **Retry after an ambiguous failure:** reconcile first. If Shopify already has the approved value,
  record the change as applied and verified without sending anything; otherwise return it to
  review.
- **Rollback:** a new change that needs approval. It refuses if the field changed since the app
  wrote it.
- **Theme writes:**
  - Off unless `THEME_WRITES_ENABLED=true`. It is **false** and must stay false until Shopify
    grants this App Store app the theme-modification exemption.
  - Never the main theme; the role is re-checked at write time.
  - Never auto-publish.
  - Back up the file first, refuse stale hashes, and verify after writing.
- **Imported report files are untrusted:**
  - Structural limits: 5 MiB, 1,000 findings, depth 16; no `__proto__`, `constructor` or
    `prototype` keys.
  - Their `autoApplicable` and risk flags never authorise anything, and selections in them are
    never treated as approval.

## AI (Google Gemini, advisory only)

- **Configuration:** server-side environment variables only: `GEMINI_API_KEY`, `GEMINI_MODEL`
  (currently `gemini-3.5-flash-lite`; there is no built-in default), `AI_TIMEOUT_MS`,
  `AI_MAX_RETRIES`, `AI_MAX_REQUESTS_PER_MINUTE` (default 8 per shop) and `AI_MAX_CONCURRENT`
  (default 2).
- **Request:** REST `generateContent` with the key in the `x-goog-api-key` header, JSON mode and a
  response schema. No tools. Only 408, 429 and 5xx are retried, and quota errors stop immediately.
- **Prompt:** minimal data (titles, type, brand, description, current SEO values, audit text). It
  includes no shop domain, IDs or customer data. Store and audit text sit inside
  `<untrusted_data>`, and evidence items are numbered (A1, S1...).
- **Required output fields:** `findingId`, `category`, `evidenceRefs[]`, `likelyRootCause`,
  `confidence`, `uncertainties[]`, `recommendedAction`, `proposedValue` or `patchCandidate`,
  `requiredResourceType`, `validationRequirements[]`, `risk`, `automationSuggested` and
  `manualReviewReason`.
- **The server rejects an answer when:**
  - the finding, category or resource type is wrong
  - it cites evidence ids that were not sent
  - it gives a value without evidence
  - it contains links, HTML or Liquid
  - it makes claims or uses numbers that are not in the store data ("organic", "certified", "500
    ml"...)
  - it returns code for a value change
- **What AI output can and cannot do:**
  - AI output becomes a change only when the merchant clicks "Use this suggestion" and then
    approves.
  - The value's source is recorded (`ai`, `ai_edited`, `suggested`, `merchant` and so on).
  - `automationSuggested` is shown as an opinion and never used.

## Environment variables

`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL` (on Render),
`THEME_WRITES_ENABLED=false`, `GEMINI_API_KEY`, `GEMINI_MODEL`, optional `PAGESPEED_API_KEY`, `PAGESPEED_STRATEGY`, `PAGESPEED_TIMEOUT_MS`, and the optional `AI_*` settings
above. Secrets live only in `.env` (git-ignored) or in Render's environment settings.

## Commands

`npm run dev`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`,
`npm run dry-run -- <report.json>` (against the fake API only), and `npm run setup` (Prisma
generate plus migrate deploy).

## Current state and known gaps

- 223 automated tests pass, all against mocks. **No real Shopify write has been tested yet.**
- On the test store (`testing-4vlbptjx.myshopify.com`, Horizon theme):
  - It has 0 active products.
  - The storefront is password protected, and Shopify bot protection sometimes returns 403 to the
    app.
  - The new read-only scopes still need approval.
- The password login was fixed for the real Shopify form (`authenticity_token`) but has not been
  confirmed end to end on the real store.
- **Render runs SQLite on an ephemeral disk,** so data is lost on every deploy. Moving to Postgres
  is pending a decision.
- Speed, contrast and JavaScript errors need PageSpeed Insights (`PAGESPEED_API_KEY`) and a public storefront.
- A separate legacy Node.js audit tool (Playwright, axe, Anthropic AI) still exists outside this
  repository. Its JSON can be imported, but the app no longer depends on it.

## Rules any change must keep

- Never let AI or imported files execute anything or choose GraphQL. Only the registry's fixed
  mutations run.
- Every change needs merchant approval of an exact revision.
- Never write to the main theme, never publish themes, and keep `THEME_WRITES_ENABLED=false`.
- Never store or log secrets or the storefront password.
- Scope every query to `session.shop`.
- No real-store mutations, deploys or scope changes without explicit approval from the owner.
