# Shopify App Template - React Router

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using [React Router](https://reactrouter.com/). It was forked from the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) and converted to React Router.

Rather than cloning this repo, follow the [Quick Start steps](https://github.com/Shopify/shopify-app-template-react-router#quick-start).

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-react-router) for more details on the React Router app package.

## Upgrading from Remix

If you have an existing Remix app that you want to upgrade to React Router, please follow the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Otherwise, please follow the quick start guide below.

## Quick start

### Prerequisites

Before you begin, you'll need to [download and install the Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started) if you haven't already.

### Setup

```shell
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router
```

### Local Development

```shell
shopify app dev
```

Press P to open the URL to your app. Once you click install, you can start development.

Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes pre-configured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks. Please see [/app/routes/webhooks.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/webhooks.app.uninstalled.tsx).
4. Using metafields, metaobjects, and declarative custom data definitions. Please see [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx) and [shopify.app.toml](https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml).

Please read the [documentation for @shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router) to see what other API's are available.

## Shopify Dev MCP

This template is configured with the Shopify Dev MCP. This instructs [Cursor](https://cursor.com/), [GitHub Copilot](https://github.com/features/copilot) and [Claude Code](https://claude.com/product/claude-code) and [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) to use the Shopify Dev MCP.

For more information on the Shopify Dev MCP please read [the documentation](https://shopify.dev/docs/apps/build/devmcp).

## Deployment

### Application Storage

This template uses [Prisma](https://www.prisma.io/) to store session data, by default using an [SQLite](https://www.sqlite.org/index.html) database.
The database is defined as a Prisma schema in `prisma/schema.prisma`.

This use of SQLite works in production if your app runs as a single instance.
The database that works best for you depends on the data your app needs and how it is queried.
Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Build the app by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/launch/deployment) to host it externally. From there, you have a few options:

- [Google Cloud Run](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run): This tutorial is written specifically for this example repo, and is compatible with the extended steps included in the subsequent [**Build your app**](tutorial) in the **Getting started** docs. It is the most detailed tutorial for taking a React Router-based Shopify app and deploying it to production. It includes configuring permissions and secrets, setting up a production database, and even hosting your apps behind a load balancer across multiple regions.
- [Fly.io](https://fly.io/docs/js/shopify/): Leverages the Fly.io CLI to quickly launch Shopify apps to a single machine.
- [Render](https://render.com/docs/deploy-shopify-app): This tutorial guides you through using Docker to deploy and install apps on a Dev store.
- [Manual deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service): This resource provides general guidance on the requirements of deployment including environment variables, secrets, and persistent data.

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Gotchas / Troubleshooting

### Database tables don't exist

If you get an error like:

```
The table `main.Session` does not exist in the current database.
```

Create the database for Prisma. Run the `setup` script in `package.json` using `npm`, `yarn` or `pnpm`.

### Navigating/redirecting breaks an embedded app

Embedded apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `react-router` or `@shopify/polaris`. Do not use `<a>`.
2. Use `redirect` returned from `authenticate.admin`. Do not use `redirect` from `react-router`
3. Use `useSubmit` from `react-router`.

This only applies if your app is embedded, which it will be by default.

### Webhooks: shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.

Instead of using the `afterAuth` hook declare app-specific webhooks in the `shopify.app.toml` file. This approach is easier since Shopify will automatically sync changes every time you run `deploy` (e.g: `npm run deploy`). Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?deliveryMethod=https)

If you do need shop-specific webhooks, keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, uninstall and reinstall the app. Revisiting the app will call the `afterAuth` hook.

### Webhooks: Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.

The recommended solution is to use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead. Test your webhooks by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Webhooks: Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app. This is expected.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

If so, please update [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/.graphqlrc.ts).

### Using Defer & await for streaming responses

By default the CLI uses a cloudflare tunnel. Unfortunately cloudflare tunnels wait for the Response stream to finish, then sends one chunk. This will not affect production.

To test [streaming using await](https://reactrouter.com/api/components/Await#await) during local development we recommend [localhost based development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options#localhost-based-development).

### "nbf" claim timestamp check failed

This is because a JWT token is expired. If you are consistently getting this error, it could be that the clock on your machine is not in sync with the server. To fix this ensure you have enabled "Set time and date automatically" in the "Date and Time" settings on your computer.

### Using MongoDB and Prisma

If you choose to use MongoDB with Prisma, there are some gotchas in Prisma's MongoDB support to be aware of. Please see the [Prisma SessionStorage README](https://www.npmjs.com/package/@shopify/shopify-app-session-storage-prisma#mongodb).

### Unable to require(`C:\...\query_engine-windows.dll.node`).

Unable to require(`C:\...\query_engine-windows.dll.node`).
The Prisma engines do not seem to be compatible with your system.

query_engine-windows.dll.node is not a valid Win32 application.

**Fix:** Set the environment variable:

```shell
PRISMA_CLIENT_ENGINE_TYPE=binary
```

This forces Prisma to use the binary engine mode, which runs the query engine as a separate process and can work via emulation on Windows ARM64.

## Resources

React Router:

- [React Router docs](https://reactrouter.com/home)

Shopify:

- [Intro to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [Shopify App React Router docs](https://shopify.dev/docs/api/shopify-app-react-router)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify App Bridge](https://shopify.dev/docs/api/app-bridge-library).
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components).
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)

Internationalization:

- [Internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)

## Audit issue fixing system

Imports reports from the separate Node.js audit tool (unchanged, not part of this repository) and
applies a small set of merchant-approved, verifiable fixes through the Admin API.

- **Pages:** Audit results (`/app/audits`), Fix issues (`/app/audits/:id`), Review and apply
  (`/app/audits/:id/review`), Execution history (`/app/history`).
- **Tests:** `npm test` (mocks only; network access is blocked in tests). **Dry run** of the whole
  workflow against an in-memory fake Admin API (never a real store):
  `npm run dry-run -- path/to/report.json [--theme-writes]`.

### In-app audit (default)

**Audit results > Run audit now** audits the store from inside this app (`app/audit/engine.server.js`).
No external tool is needed, and the audit only reads the store.

What it checks:
- **Shopify Admin data:** up to 250 active products and 100 collections.
  - SEO title length (15–60 characters).
  - Missing meta description, or one outside 50–165 characters.
  - Product images whose alt text is empty or weak (`admin.media.alt-missing`). This is a
    confirmed cause, so it is fixable without acknowledgement.
- **The published theme's files:** `<html lang>` and the canonical tag. These are read through
  the API, so this works on password-protected development stores.
- **Catalog quality:**
  - Active products with no images, fewer than 30 words of description, or every variant priced 0.
  - Empty collections, and collection images without alt text.
  - Duplicate SEO titles or descriptions across products, collections, pages and blog posts.
- **Store setup:** password protection still on, and the primary domain still `*.myshopify.com`.
- **Pages, blog posts and menus:** these need the read-only `read_online_store_pages`,
  `read_content` and `read_online_store_navigation` permissions.
  - SEO title and description of published pages and blog posts, read from the
    `global.title_tag` / `global.description_tag` metafields with the body summary as fallback.
  - A missing contact page.
  - Menu items that point to deleted products, collections or pages.
  - Fixing these is manual; the app has no write permission for them.
- **Theme files:**
  - Open Graph tags in the layout or its `<head>` snippets.
  - Product structured data, found by following `templates/product.json` to its sections and the
    snippets they render.
  - Five or more unpublished themes.
  - The favicon, from `config/settings_data.json`.
  - Anything that cannot be resolved is reported as "not checked", never as an issue.
- **Coverage:** every audit lists what it could not check and why (no active products, storefront
  locked or blocked, missing permission). Categories that were not checked are left out of the score.
- **Store policies:** empty privacy, refund, terms of service and shipping policies. This needs the
  read-only `read_legal_policies` permission and is skipped, with a note, until the store grants it.
- **Optional storefront pages:** the homepage plus up to 5 sampled product and collection pages,
  fetched as static HTML through `safeFetchText` on the shop's own domains only.
  - Page checks: title, H1, `<img>` alt, Open Graph, JSON-LD, render-blocking scripts, third-party
    script hosts and `http://` resources.
  - Homepage SEO: title length and meta description.
  - Accessibility rules decidable from HTML: `label`, `autocomplete-valid`, `link-name`,
    `button-name`, `landmark-one-main` and `duplicate-id`.
  - Up to 20 internal links are tested for broken ones.
- **Password-protected stores:** the merchant can enter the storefront password for one run. It is
  posted only to the shop's own `/password` form, kept in memory for that run, and never stored or
  logged. Without it, storefront pages are skipped and the report says so. The audit never scores
  the password page itself.

The audit runs no browser, so it reports no speed metrics (LCP, FCP, CLS, INP), no colour contrast
and no JavaScript errors.

**Score:**
- Each checked category starts at 100 and loses 25, 15, 8 or 3 points per critical, high, medium
  or low finding (minimum 0).
- The overall score is the average of the categories that were actually checked; unchecked
  categories show "Not checked".
- "What to fix first" ranks findings by severity, then by whether the app can fix them, then by
  how often they occur.

**Storefront request limits:**
- Requests are sent one at a time, up to 40 per audit including retries.
- Each URL is fetched once per audit (in-memory cache, 5 minutes).
- Only HTTP 429 and 503 are retried, at most twice. The app waits for `Retry-After` when it is
  10 seconds or less; otherwise it uses capped exponential backoff with jitter.
- HTTP 403 is reported as **blocked**, a final 429 as **rate limited**, and the app stops
  requesting.
- Only 404 and 410 count as broken links.
- Up to 2 same-store redirects are followed, and each one is re-validated.
- These statuses never deduct points. They appear in the coverage banner, and the rest of the
  audit still runs.

**Speed, colour contrast and JavaScript errors** come from Google PageSpeed Insights, which is
optional:
- Set `PAGESPEED_API_KEY` on the server. Optionally set `PAGESPEED_STRATEGY` (`MOBILE` or
  `DESKTOP`, default `MOBILE`) and `PAGESPEED_TIMEOUT_MS` (default 60000).
- Only the public homepage URL is sent to Google. The key goes in a request header, and is never
  logged or shown in the browser.
- Lab data (one Lighthouse run) and real-user field data (Chrome UX Report) are shown separately.
  Missing values show as "not available".
- A password-protected store is not measured: Google cannot log in to it.
- Without a key, these show as "not measured".
- Quotas and pricing are set per Google Cloud project; check them in the Google Cloud console.

**Permissions:** the audit asks Shopify which scopes are actually granted
(`currentAppInstallation.accessScopes`) instead of trusting the stored session. A missing
permission is reported as "not checked", and a failed read as "error"; neither is ever treated as
empty data.

**Choosing the theme:**
- The theme for theme fixes is chosen once: on the Run audit form, or at the top of the Fix
  issues page.
- Only unpublished or development themes are offered.
- Admin fixes never need a theme.

**Prepare all fixable issues** creates proposals for every finding the app can fix. They still have
to be approved and confirmed on the review page.

Uploading a report file from the separate Node tool remains available as an optional import.

### Source report contract

The current format is the tool's `schemaVersion: 1` JSON, validated strictly
(`app/fixes/importer.server.js`, `app/fixes/reportContract.server.js`):

```
{ schemaVersion: 1, generatedAt, meta: { url, host, crawledAt, device, narrativeGeneratedBy },
  summary: { overall, grade, counts, totalFindings, autoApplicableFixes, pagesCrawled },
  overall, grade, findings: Finding[], categoryScores, counts, pagesCrawled,
  cwv (homepage only) | null, cdpMetrics (homepage only) | null, narrative }
Finding: { id, category, severity, title, detail, recommendation, evidence|null, url|null,
  affectedUrls[], pageCount, instances, fix: { fix_type, risk, autoApplicable, explanation,
  generated_fix, estimated_impact, generatedBy } | null }
```

Legacy formats are accepted, labelled and validated separately: the older `--json` output
(`{ meta, analysis: { findings } }`) and the HTML report's unversioned `approved-fixes.json`
(`{ meta, fixes }`), whose selections are never treated as approval.

What the report can and cannot show is displayed with each finding:
- Findings are aggregated by issue id across sampled pages (homepage links, five by default). They
  are not a full crawl.
- Evidence lines are deduplicated and no longer tied to a page.
- URLs are the requested URLs, not the final redirected ones.
- Performance data is one browser lab run, not Lighthouse, PSI, CrUX or INP.
- `autoApplicable`, `risk` and scores are advisory and never authorize anything.
- Missing storefront metadata is not taken as proof that Admin data is empty.

### Internal contract (contractVersion 1)

Stored on `AuditImport`:
- `id`, the server-generated report id.
- `contractVersion`, `sourceSchemaVersion` and `sourceFormat`.
- `rawSha256` of the uploaded bytes.
- `contentDigest`, the SHA-256 of canonical JSON with keys sorted.
- `auditedUrl` and `auditedHost`, the validated source URL and host.
- `sourceGeneratedAt` and `auditDate` (crawledAt). These are null when absent and are never invented.
- `shop`, taken from the authenticated session.
- `createdAt`, the time of import.
- `findingsJson` and `importWarnings`, which hold validation notes and summary-consistency notes.
- `reportJson`, which holds device, sampled pages, homepage metrics, narrative and unsupported findings.

Each finding keeps its source `id` and evidence and gets a stable `findingId`. It is `f_` plus 24 hex
characters of SHA-256 over `[issue id, sorted normalised affected URLs, evidence]`. Changes are
identified separately by resource, field and fix type (`FixExecution.dedupeKey`).

Import rules:
- **Limits:** 5 MiB, 1,000 findings, 200 URLs per finding, nesting depth 16, lists of up to 5,000
  items, strings of up to 200,000 characters, 500 keys per object and 250,000 values in total.
  `__proto__`, `constructor` and `prototype` keys are rejected anywhere in the file.
- **Rejected inputs:** invalid JSON, unknown `schemaVersion`, wrong field types, and findings
  without an issue id. ZIP files and remote report URLs are not accepted.
- **Duplicates:** an exact duplicate finding is dropped with a note. A conflicting duplicate (same
  id, different content) is kept once, flagged and never executable.
- **Re-imports:** an identical re-import in the same shop (same `contentDigest`) returns the
  existing import. Imports never create or restore approvals.
- **Unknown issue ids** stay visible as **Unsupported**.

### Finding matrix

| Class | Issue ids | What the app does |
|---|---|---|
| Admin API fix (after resource check and approval) | `seo.meta-description.missing`, `seo.meta-description.length`, `seo.title.length` (product/collection URLs) | Resolves the resource, checks the root cause in Admin data, proposes an SEO value |
| Needs more evidence | `seo.img.alt-missing`, `a11y.image-alt` (audit counts cannot identify media files); Admin findings without affected URLs | Optional, acknowledged product-media alt-text improvement only |
| Theme patch candidate (preview) | `seo.lang.missing`, `a11y.html-has-lang`, `seo.canonical.missing` | Inspects the live and unpublished theme, previews an exact diff; writes stay disabled |
| Manual recommendation | `seo.title.missing`, `seo.h1.*`, `seo.og.missing`, `seo.structured-data.missing`, all `perf.*`, `links.*`, `shopify.*`, `trust.*`, `js.*`, `fonts.*`, `code.*`, other `a11y.*` | Guidance and optional AI explanation; no automatic change |
| Unsupported | unknown ids, conflicting duplicates | Shown with the reason; never executable |

URL resolution:
- Only the handle is taken from a URL. The resource is fetched through the authenticated Admin API,
  and the returned handle must match exactly.
- A locale prefix is accepted only before `products`, `collections`, `pages` or `blogs`.
- Collection-qualified product URLs resolve to the product. The collection segment never selects a
  resource.
- The following are never mapped to a product or collection:
  - `/collections/all`, `/collections/vendors` and `/collections/types`
  - feed or data URLs (`.json`, `.js`, `.xml`, `.atom`, `.oembed`, `.rss`)
  - extra path segments
  - homepage, page, blog, cart and policy routes

### Proposal lifecycle and approval

States are `pending_review`, `approved`, `rejected`, `manual_review`, `executing`, `verified`,
`verification_pending`, `verification_failed`, `stale` and `failed`. An AI suggestion that has not
been used is a separate, advisory "draft" (`AiSuggestion`).

Every review-relevant change increments `FixExecution.revision`: refresh, approve, return to
review, reject, manual review, stale and retry.
- **Approval** must state the revision the merchant saw. The approval's HMAC covers the shop,
  revision, finding, resource, fix type, value and before-state.
- **Execution** refuses if the stored revision or hash no longer match.
- **Batches** are confirmed with a token for the exact set of approvals shown.
- **Bulk approval** applies every per-change check.

### Execution, verification and recovery

Execution takes these steps:
1. Authenticate the request.
2. Check that the shop owns the report and the change.
3. Check that the approved revision and hash match.
4. Re-check scopes and theme-write eligibility.
5. Claim the change atomically (`APPROVED` to `APPLYING`, counted in `attempts`).
6. Read the current state, and mark the change stale or duplicate if it changed.
7. Re-validate the approved value.
8. Send one fixed, allowlisted mutation.
9. Check HTTP, GraphQL and `userErrors`.
10. Read the value back and compare it with the approved value, including unrelated guard fields.
11. Persist before and after, the outcome and recovery guidance.

Read-back proves that Shopify saved the data. It does not prove the storefront changed; the
optional storefront re-check reports that separately.

Recovery:
- **No automatic retry.** After an ambiguous failure (timeout, dropped connection) the app never
  retries automatically. **Retry** first reads Shopify: if the approved value is already saved, the
  change is recorded as applied and verified by read-back without sending anything; otherwise it
  returns to review.
- **Not atomic.** Database transactions do not make Shopify writes atomic. A crash between the
  mutation and the database update leaves `APPLYING`, which Retry reconciles after 10 minutes.
- **Rollback** is a new change that needs approval. It refuses if the field changed since the app
  wrote it.

### Storefront re-check (only server-side fetch)

The URL is built from the shop's own domain and a handle returned by the Admin API, never from a
report. `app/fixes/safeFetch.server.js` enforces:
- https only, on the default port, with no credentials in the URL
- a host allowlist
- public addresses only (IPv4, IPv6, and mapped or embedded IPv4), validated inside the socket's
  DNS lookup so rebinding cannot swap the address
- validation on every redirect hop (the re-check follows none)
- an 8-second deadline and a 2 MB response cap

### Theme workflow

`THEME_WRITES_ENABLED` defaults to off and must stay off until Shopify grants this app the
theme-modification exemption that `themeFilesUpsert` requires (in addition to `write_themes`).
While writes are disabled, patches are previews with manual instructions.

If writes are ever enabled, these rules apply:
- Patches come only from fixed templates after inspecting the live and unpublished theme.
- They target an explicitly selected unpublished or development theme, never the main theme. The
  theme's role is re-checked at write time.
- The original file is backed up first. If the backup fails, nothing is written.
- Patches are hash-bound and refused if stale. Jobs are polled and the saved content is verified.
- Themes are never published.
- Shopify has no conditional write for theme files, so a change made in the code editor between
  the final check and the write cannot be ruled out. Verification detects it afterwards.

### AI suggestions (Google Gemini)

AI is advisory only. It drafts SEO and alt-text values and explains findings; it can never change
the store, choose resources or approve anything.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | to enable AI | none | Server-side only. Never commit it. |
| `GEMINI_MODEL` | to enable AI | **none** | No built-in default, because models are retired. On 2026-10-28 the Gemini models page listed `gemini-3.5-flash-lite` as stable with structured-output support; re-check before use. |
| `AI_PROVIDER` | no | `gemini` if a key is set, else `none` | `none` turns AI off. |
| `AI_TIMEOUT_MS` | no | `20000` | 3000–60000. |
| `AI_MAX_RETRIES` | no | `2` | 0–3; only 408/429/5xx are retried; quota errors are not. |
| `AI_MAX_REQUESTS_PER_MINUTE` | no | `8` | Per shop. |
| `AI_MAX_CONCURRENT` | no | `2` | Per server process; one request per shop at a time. |

Output is JSON validated against this schema: `findingId`, `category`, `evidenceRefs[]`,
`likelyRootCause`, `confidence`, `uncertainties[]`, `recommendedAction`, `proposedValue` or
`patchCandidate`, `requiredResourceType`, `validationRequirements[]`, `risk`,
`automationSuggested` and `manualReviewReason`.

The server rejects an answer when:
- the finding, category or resource type differs from the server's own values
- it cites evidence ids that were not sent
- it proposes a value without citing evidence
- it contains links, HTML or Liquid, or fails the length rules
- it introduces claims or numbers that are not in the store's data
- it returns both a value and a patch
- it returns code for a value change

An analysis may include code only as unverified display text. `automationSuggested` is recorded
as the model's opinion and never used.

Free-tier caveats (Gemini API terms):
- Google may use free-tier prompts and responses to improve its products, with human review.
- The free tier must not be used for apps offered to users in the EEA, UK or Switzerland.
- Quotas are per project, are shown in AI Studio, and are not guaranteed.

The app sends only finding text and product or collection title, type, brand and description. It
sends no shop domain, IDs, customer or order data. Use a paid tier for real merchants.

### Admin fix types (resource · operation · scope · verification · recovery)

| Fix type | Resource / operation | Scope | Verification | Recovery |
|---|---|---|---|---|
| Product SEO title / description | `Product.seo` via `productUpdate(product: {id, seo})` | `write_products` | Re-read SEO + title, handle, status, vendor, type, template, body | Reviewed rollback if previous value was non-empty |
| Collection SEO title / description | `Collection.seo` via `collectionUpdate(collection: {id, seo})` | `write_products` | Re-read SEO + title, handle, template, body | Same as above |
| Product image alt text (missing or weak) | `MediaImage.alt` via `fileUpdate` (READY media of the product only) | `write_products`, `write_files` | Re-read the product's media | Same as above. Alt text belongs to the file, so it also changes wherever the same file is reused. |

Evaluated and **not** added:
- collection image alt (the `collectionUpdate` image input could replace the image; unverified)
- product titles and descriptions (no audit finding targets them, and they change visible
  storefront content)
- app removal, policy generation, redirects and image replacement
- anything touching prices, inventory, status, orders or customers

### Configuration and safe migration

1. Add variables to `.env` locally or to the host's environment settings. Never put them in code.
2. Run `npm run setup` (`prisma generate && prisma migrate deploy`), or start `npm run dev`. The
   migration `20261028150000_report_contract_and_revisions` is additive: new nullable
   `AuditImport` columns, `FixExecution.revision` (default 1) and a unique index on
   `(shop, contentDigest)`. Existing rows keep working. Never use `migrate reset` or `db push`
   against production data.
3. On SQLite hosts with ephemeral disks (such as Render without a persistent disk), the database
   and with it all history and backups are lost on every deploy.
