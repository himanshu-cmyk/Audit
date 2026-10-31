// In-app store audit. Builds the same normalised findings the importer produces,
// from three sources this app can read itself:
//
//  1. Shopify Admin data (authenticated): product and collection SEO fields and
//     product media alt text. These findings name exact resources, so the fix
//     registry can act on them directly.
//  2. The published theme's files (read_themes): html lang and canonical tag.
//  3. Optionally, a few public storefront pages fetched as static HTML through
//     safeFetchText (shop's own domains only). No browser runs and no scripts
//     execute, so there are no Core Web Vitals; password-protected storefronts
//     are skipped and the audit says so.
//
// The audit only reads. It never changes the store.

import { displayCategoryFor } from "../fixes/constants";
import { runGraphql } from "../fixes/graphql.server";
import { isWeakAlt } from "../fixes/handlers/imageAlt.server";
import { THEME_FILE_QUERY, listThemes } from "../fixes/handlers/theme.server";
import { THEME_PATCHES, headIncludes } from "../fixes/handlers/themePatches.server";
import { isKnownSourceId, stableFindingId } from "../fixes/reportContract.server";
import { lookupByHandle } from "../fixes/resolve.server";
import { safeFetchText } from "../fixes/safeFetch.server";
import { cleanText } from "../fixes/text";
import { accessibilityIssues, scanHtml } from "./html.server";
import { measureHomepageLocally } from "./lighthouse.server";
import { measureHomepage } from "./pagespeed.server";
import { CHECK_STATUS, createStorefrontClient } from "./storefrontClient.server";
import { FixError } from "../fixes/graphql.server";

export const SCAN_PRODUCTS_QUERY = `#graphql
  query StoreAuditScanProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active", sortKey: TITLE) {
      nodes {
        id
        handle
        title
        description(truncateAt: 2000)
        seo {
          title
          description
        }
        priceRangeV2 {
          maxVariantPrice {
            amount
          }
        }
        media(first: 20) {
          nodes {
            id
            alt
            status
            mediaContentType
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

export const SCAN_COLLECTIONS_QUERY = `#graphql
  query StoreAuditScanCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      nodes {
        id
        handle
        title
        description(truncateAt: 600)
        seo {
          title
          description
        }
        productsCount {
          count
        }
        image {
          altText
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

export const SHOP_POLICIES_QUERY = `#graphql
  query StoreAuditShopPolicies {
    shop {
      shopPolicies {
        type
        body
      }
    }
  }`;

export const STORE_SETUP_QUERY = `#graphql
  query StoreAuditStoreSetup {
    shop {
      contactEmail
      primaryDomain {
        host
      }
    }
    onlineStore {
      passwordProtection {
        enabled
      }
    }
  }`;

export const SCAN_PAGES_QUERY = `#graphql
  query StoreAuditScanPages($first: Int!) {
    pages(first: $first) {
      nodes {
        id
        handle
        title
        isPublished
        bodySummary
        titleTag: metafield(namespace: "global", key: "title_tag") {
          value
        }
        descriptionTag: metafield(namespace: "global", key: "description_tag") {
          value
        }
      }
    }
  }`;

export const SCAN_ARTICLES_QUERY = `#graphql
  query StoreAuditScanArticles($first: Int!) {
    articles(first: $first) {
      nodes {
        id
        handle
        title
        isPublished
        summary
        blog {
          handle
        }
        titleTag: metafield(namespace: "global", key: "title_tag") {
          value
        }
        descriptionTag: metafield(namespace: "global", key: "description_tag") {
          value
        }
      }
    }
  }`;

export const MENUS_QUERY = `#graphql
  query StoreAuditMenus {
    menus(first: 10) {
      nodes {
        handle
        title
        items {
          title
          type
          url
          resourceId
          items {
            title
            type
            url
            resourceId
            items {
              title
              type
              url
              resourceId
            }
          }
        }
      }
    }
  }`;

// The scopes Shopify has actually granted to this installation. session.scope can
// lag behind (it is refreshed by the app/scopes_update webhook).
export const GRANTED_SCOPES_QUERY = `#graphql
  query StoreAuditGrantedScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }`;

export const PRODUCT_COUNTS_QUERY = `#graphql
  query StoreAuditProductCounts {
    all: productsCount(limit: null) {
      count
    }
    active: productsCount(query: "status:active", limit: null) {
      count
    }
    draft: productsCount(query: "status:draft", limit: null) {
      count
    }
  }`;

export const AUDIT_LIMITS = { products: 250, collections: 100, pageSize: 50, storefrontPages: 6, linkChecks: 20, pages: 100, articles: 100, menuLookups: 20 };

// Same ranges the SEO fix handler uses for its root-cause check, so a finding
// raised here is one the handler will accept.
const TITLE_RANGE = [15, 60];
const DESCRIPTION_RANGE = [50, 165];

const norm = (v) => (typeof v === "string" ? v.trim() : "");

const FINDING_TEXT = {
  "seo.title.length": {
    title: "SEO title length is outside the recommended range",
    severity: "low",
    detail: "The title Shopify uses for search results (SEO title, or the item title when no SEO title is set) is shorter than 15 or longer than 60 characters.",
    recommendation: "Set an SEO title of roughly 30–60 characters that describes the item.",
  },
  "seo.meta-description.missing": {
    title: "Meta description is missing",
    severity: "medium",
    detail: "There is no SEO description and no description text Shopify could use instead, so search engines get no summary.",
    recommendation: "Write an SEO description of about 70–160 characters.",
  },
  "seo.meta-description.length": {
    title: "Meta description length is outside the recommended range",
    severity: "low",
    detail: "The description Shopify uses for search results (SEO description, or the item description when none is set) is shorter than 50 or longer than 165 characters.",
    recommendation: "Set an SEO description of about 70–160 characters.",
  },
  "admin.media.alt-missing": {
    title: "Product images without useful alt text",
    severity: "medium",
    detail: "These product images have empty or generic alt text (file names, camera names, words like \"image\") in Shopify Admin.",
    recommendation: "Describe what each image shows in its alt text.",
  },
  "seo.lang.missing": {
    title: "Page language is not declared",
    severity: "medium",
    detail: "The <html> tag in the published theme has no lang attribute.",
    recommendation: "Add lang=\"{{ request.locale.iso_code }}\" to the <html> tag.",
  },
  "seo.canonical.missing": {
    title: "Canonical link tag is missing",
    severity: "medium",
    detail: "Neither the published theme's layout nor the snippets it renders in <head> output a canonical link.",
    recommendation: "Output <link rel=\"canonical\" href=\"{{ canonical_url }}\"> in <head>.",
  },
  "seo.title.missing": { title: "Page has no <title>", severity: "high", detail: "The page HTML has no <title> element.", recommendation: "Make sure the theme outputs <title>{{ page_title }}</title>." },
  "seo.h1.missing": { title: "Page has no H1 heading", severity: "medium", detail: "No <h1> element was found in the page HTML.", recommendation: "Give each page one H1 that names its main topic." },
  "seo.h1.multiple": { title: "Page has several H1 headings", severity: "low", detail: "More than one <h1> element was found in the page HTML.", recommendation: "Keep one H1 per page; use H2/H3 for other headings." },
  "seo.img.alt-missing": { title: "Images without an alt attribute on the storefront", severity: "medium", detail: "<img> tags in the page HTML have no alt attribute. These may come from the theme, sections or apps rather than product media.", recommendation: "Add alt text in the theme editor or the app that renders these images." },
  "seo.og.missing": { title: "Social sharing (Open Graph) tags are missing", severity: "low", detail: "The page HTML has no og:title or og:image meta tag.", recommendation: "Output Open Graph tags in <head> (most themes have a meta-tags snippet)." },
  "seo.structured-data.missing": { title: "No structured data", severity: "low", detail: "No JSON-LD (application/ld+json) block was found in the page HTML.", recommendation: "Output product/organization structured data from the theme." },
  "code.render-blocking": { title: "Render-blocking scripts in <head>", severity: "medium", detail: "External scripts in <head> load without async or defer, which delays rendering.", recommendation: "Load non-critical scripts with defer or async, or remove unused app scripts." },
  "shopify.app-bloat": { title: "Many third-party script hosts", severity: "medium", detail: "The page loads scripts from many third-party hosts.", recommendation: "Review installed apps and remove the ones you no longer use." },
  "trust.mixed-content": { title: "Insecure (http) resources", severity: "high", detail: "The page references resources over plain http.", recommendation: "Use https URLs for all images, scripts and stylesheets." },
  "a11y.label": { title: "Form fields without a label", severity: "high", detail: "Inputs, selects or text areas have no label, aria-label or aria-labelledby, so screen readers cannot announce them.", recommendation: "Give every form field a visible <label> (or aria-label) in the theme or the app that renders the form." },
  "a11y.autocomplete-valid": { title: "Invalid autocomplete values", severity: "medium", detail: "Form fields use an autocomplete value that browsers and assistive technology do not recognise.", recommendation: "Use a standard autocomplete token (for example email, current-password, postal-code)." },
  "a11y.link-name": { title: "Links without readable text", severity: "high", detail: "Links have no text, image alt or aria-label, so screen readers announce them only as \"link\".", recommendation: "Add text or an aria-label to icon links (social icons, cart, logo)." },
  "a11y.button-name": { title: "Buttons without readable text", severity: "high", detail: "Buttons have no text or aria-label.", recommendation: "Add text or an aria-label to icon buttons." },
  "a11y.landmark-one-main": { title: "Page does not have exactly one main landmark", severity: "medium", detail: "Pages should have one <main> element so assistive technology can jump to the content.", recommendation: "Wrap the page content in a single <main> element in the theme layout." },
  "a11y.duplicate-id": { title: "Duplicate element ids", severity: "low", detail: "Several elements share the same id, which breaks labels and aria references.", recommendation: "Make ids unique in the theme sections that repeat them." },
  "links.broken": { title: "Broken internal links", severity: "high", detail: "Links on the checked pages lead to pages on your store that return an error.", recommendation: "Update or remove these links in your navigation, theme or page content." },
  "shopify.favicon.missing": { title: "No favicon set", severity: "low", detail: "The published theme has no favicon, so browser tabs show a generic icon.", recommendation: "Upload a square image under Online Store > Themes > Customize > Theme settings > Favicon." },
  "catalog.product.no-images": { title: "Active products without images", severity: "high", detail: "These active products have no images, so shoppers and Google Shopping see nothing.", recommendation: "Add at least one clear product photo to each product." },
  "catalog.product.thin-description": { title: "Products with little or no description", severity: "medium", detail: "These products have fewer than 30 words of description, which gives shoppers and search engines little to go on.", recommendation: "Describe what the product is, what it is made of, sizes or quantities, and how to use it." },
  "catalog.product.zero-price": { title: "Active products priced at 0", severity: "high", detail: "Every variant of these active products costs 0, so they would be given away at checkout.", recommendation: "Set the correct prices, or set the products to draft until they are ready." },
  "catalog.collection.empty": { title: "Empty collections", severity: "low", detail: "These collections contain no products, so their pages are empty.", recommendation: "Add products, or remove the collection from menus and unpublish it." },
  "admin.collection-image.alt-missing": { title: "Collection images without alt text", severity: "low", detail: "These collection images have no alt text in Shopify Admin.", recommendation: "Add alt text to the collection image in Products > Collections." },
  "seo.title.duplicate": { title: "Several pages share the same SEO title", severity: "medium", detail: "Products, collections or pages use exactly the same search title, so search engines cannot tell them apart.", recommendation: "Give each item a unique SEO title." },
  "seo.meta-description.duplicate": { title: "Several pages share the same meta description", severity: "low", detail: "Products, collections or pages use exactly the same search description.", recommendation: "Write a unique SEO description for each item." },
  "shopify.store.password-protected": { title: "The store is password protected", severity: "high", detail: "Online Store password protection is on, so shoppers and search engines cannot see the store.", recommendation: "Remove the password in Online Store > Preferences when you are ready to launch." },
  "trust.domain.custom-missing": { title: "No custom domain", severity: "medium", detail: "The store's primary domain is the default myshopify.com address, which looks less trustworthy to shoppers.", recommendation: "Connect your own domain in Settings > Domains and make it primary." },
  "trust.contact.missing": { title: "No contact page", severity: "medium", detail: "No published page uses the contact template or a contact handle.", recommendation: "Create a Contact page in Online Store > Pages (template: contact) and link it in the footer." },
  "shopify.themes.unused": { title: "Many unused themes", severity: "low", detail: "The store keeps several unpublished themes. Shopify allows 20, and old copies make it easy to edit the wrong one.", recommendation: "Delete theme copies you no longer need (keep one draft for fixes)." },
  "links.menu-broken": { title: "Menu links to items that no longer exist", severity: "high", detail: "Navigation menus link to products, collections or pages that were deleted, so shoppers land on an error page.", recommendation: "Edit the menu in Online Store > Navigation and remove or relink these items." },
  "perf.cwv.lcp": { title: "Largest Contentful Paint is slow", severity: "medium", detail: "The main content of the homepage takes longer than 2.5 seconds to appear.", recommendation: "Compress and correctly size the hero image, avoid lazy-loading it, and reduce render-blocking scripts and styles." },
  "perf.cwv.cls": { title: "Layout shifts while the page loads", severity: "medium", detail: "Content moves around while the homepage loads (Cumulative Layout Shift above 0.1).", recommendation: "Give images, embeds and banners fixed dimensions and avoid inserting content above existing content." },
  "perf.cwv.inp-tbt": { title: "The page is slow to respond to input", severity: "medium", detail: "Long JavaScript tasks block the main thread (lab Total Blocking Time), or real users see slow interactions (INP).", recommendation: "Remove unused apps and scripts, and defer non-critical JavaScript." },
  "code.console-errors": { title: "JavaScript errors on the homepage", severity: "medium", detail: "The browser logged errors while loading the homepage. They can break add-to-cart, tracking or app features.", recommendation: "Open the browser console on the homepage, find the script causing each error, and fix or remove it (often a leftover from a removed app)." },
  "a11y.color-contrast": { title: "Text with too little colour contrast", severity: "high", detail: "Some text does not meet the WCAG AA contrast ratio against its background, as measured in a real browser.", recommendation: "Darken the text or lighten the background in the theme's colour settings so body text reaches at least 4.5:1." },
  "trust.policies.missing": { title: "Store policies are missing", severity: "medium", detail: "Some standard store policies are empty in Settings > Policies. Shoppers look for them, and ad platforms may require them.", recommendation: "Add the missing policies in Settings > Policies and link them in your footer." },
};

const CATEGORY = {
  "perf.cwv.lcp": "performance",
  "perf.cwv.cls": "performance",
  "perf.cwv.inp-tbt": "performance",
  "code.console-errors": "performance",
  "admin.media.alt-missing": "accessibility",
  "admin.collection-image.alt-missing": "accessibility",
  "catalog.product.no-images": "shopify",
  "catalog.product.thin-description": "shopify",
  "catalog.product.zero-price": "shopify",
  "catalog.collection.empty": "shopify",
  "shopify.store.password-protected": "shopify",
  "shopify.themes.unused": "shopify",
  "trust.domain.custom-missing": "trust",
  "trust.contact.missing": "trust",
  "links.menu-broken": "links",
  "links.broken": "links",
  "shopify.favicon.missing": "shopify",
  "trust.policies.missing": "trust",
  "code.render-blocking": "performance",
  "shopify.app-bloat": "shopify",
  "trust.mixed-content": "trust",
};

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// Collects hits per issue id; one finding per id, like the external report.
// The same issue found by several sources (Admin, theme, storefront, PageSpeed)
// becomes one finding with every source listed in `origin`.
function createCollector() {
  const byId = new Map();
  return {
    add(id, { url = null, evidence = null, origin, severity = null, title = null }) {
      const entry = byId.get(id) || { urls: [], evidence: [], instances: 0, origins: new Set(), severity: null, title: null };
      // The most severe measurement wins; text comes from FINDING_TEXT when known.
      if (severity && (!entry.severity || SEVERITY_ORDER[severity] < SEVERITY_ORDER[entry.severity])) entry.severity = severity;
      if (title && !entry.title) entry.title = title;
      if (url && !entry.urls.includes(url)) entry.urls.push(url);
      if (evidence && entry.evidence.length < 60) entry.evidence.push(evidence);
      entry.instances++;
      entry.origins.add(origin);
      byId.set(id, entry);
    },
    findings() {
      return [...byId.entries()].map(([id, e]) => {
        const t = FINDING_TEXT[id] || {
          title: e.title || id,
          severity: "medium",
          detail: "Reported by an automated accessibility check (axe-core via Lighthouse) on the rendered homepage.",
          recommendation: "Open the evidence below, fix the listed elements in the theme or the app that renders them, and re-run the audit.",
        };
        const category = CATEGORY[id] || (id.startsWith("a11y.") ? "accessibility" : "seo");
        const affectedUrls = e.urls.slice(0, 200);
        const evidence = cleanText(e.evidence.join("\n"), 10000);
        return {
          key: id,
          findingId: stableFindingId(id, affectedUrls, evidence),
          sourceId: id,
          auditId: id,
          known: isKnownSourceId(id),
          origin: [...e.origins].sort().join("+"),
          title: t.title,
          category,
          displayCategory: displayCategoryFor(id, category),
          severity: e.severity || t.severity,
          description: t.detail,
          recommendation: t.recommendation,
          evidence,
          url: affectedUrls[0] ?? null,
          affectedUrls,
          pageCount: affectedUrls.length,
          instances: e.instances,
          audit: null,
        };
      });
    },
  };
}

async function scanAll(admin, query, root, limit) {
  const items = [];
  let after = null;
  let truncated = false;
  for (;;) {
    const data = await runGraphql(admin, query, { first: AUDIT_LIMITS.pageSize, after });
    const conn = data[root];
    items.push(...(conn?.nodes || []));
    if (!conn?.pageInfo?.hasNextPage) break;
    if (items.length >= limit) {
      truncated = true;
      break;
    }
    after = conn.pageInfo.endCursor;
  }
  return { items: items.slice(0, limit), truncated };
}

const KIND_LABEL = { product: "Product", collection: "Collection", page: "Page", article: "Blog post" };

// Effective search title / description per item, used to find duplicates.
function createDuplicateTracker() {
  const titles = new Map();
  const descriptions = new Map();
  const push = (map, key, entry) => key && map.set(key.toLowerCase(), [...(map.get(key.toLowerCase()) || []), entry]);
  return {
    add(label, url, title, description) {
      push(titles, title, { label, url });
      push(descriptions, description, { label, url });
    },
    report(collect) {
      for (const [id, map, what] of [["seo.title.duplicate", titles, "title"], ["seo.meta-description.duplicate", descriptions, "description"]]) {
        for (const [value, items] of map) {
          if (items.length < 2) continue;
          for (const it of items) collect.add(id, { url: it.url, origin: "admin", evidence: `${it.label} shares the search ${what} "${value.slice(0, 80)}" with ${items.length - 1} other item(s)` });
        }
      }
    },
  };
}

function checkSeo(collect, kind, item, url, duplicates, overrides = {}) {
  const label = `${KIND_LABEL[kind]} "${item.title}"`;
  const title = norm(overrides.title ?? item.seo?.title) || norm(item.title);
  if (title.length < TITLE_RANGE[0] || title.length > TITLE_RANGE[1]) {
    collect.add("seo.title.length", { url, origin: "admin", evidence: `${label}: title used for search is ${title.length} characters` });
  }
  const description = norm(overrides.description ?? item.seo?.description) || norm(overrides.fallbackDescription ?? item.description);
  duplicates?.add(label, url, title, description);
  if (!description) {
    collect.add("seo.meta-description.missing", { url, origin: "admin", evidence: `${label}: no SEO description and no description text` });
  } else if (description.length < DESCRIPTION_RANGE[0] || description.length > DESCRIPTION_RANGE[1]) {
    collect.add("seo.meta-description.length", { url, origin: "admin", evidence: `${label}: description used for search is ${description.length} characters` });
  }
}

const words = (text) => norm(text).split(/\s+/).filter(Boolean).length;

async function auditAdminData(admin, base, collect, duplicates) {
  let productCounts = null;
  try {
    const c = await runGraphql(admin, PRODUCT_COUNTS_QUERY);
    productCounts = { all: c.all?.count ?? null, active: c.active?.count ?? null, draft: c.draft?.count ?? null };
  } catch {
    // Counts are informational only.
  }
  const products = await scanAll(admin, SCAN_PRODUCTS_QUERY, "products", AUDIT_LIMITS.products);
  for (const p of products.items) {
    const url = `${base}/products/${encodeURIComponent(p.handle)}`;
    checkSeo(collect, "product", p, url, duplicates);
    const images = (p.media?.nodes || []).filter((m) => m.mediaContentType === "IMAGE");
    if (!images.length) collect.add("catalog.product.no-images", { url, origin: "admin", evidence: `Product "${p.title}" has no images` });
    const w = words(p.description);
    if (w < 30) collect.add("catalog.product.thin-description", { url, origin: "admin", evidence: `Product "${p.title}": ${w} word(s) of description` });
    const max = Number(p.priceRangeV2?.maxVariantPrice?.amount);
    if (p.priceRangeV2 && Number.isFinite(max) && max === 0) collect.add("catalog.product.zero-price", { url, origin: "admin", evidence: `Product "${p.title}": every variant costs 0` });
    images.forEach((m, i) => {
      if (m.status === "READY" && isWeakAlt(m.alt, p)) {
        collect.add("admin.media.alt-missing", {
          url,
          origin: "admin",
          evidence: `Product "${p.title}", image ${i + 1}: ${norm(m.alt) ? `weak alt "${norm(m.alt).slice(0, 60)}"` : "no alt text"}`,
        });
      }
    });
  }
  const collections = await scanAll(admin, SCAN_COLLECTIONS_QUERY, "collections", AUDIT_LIMITS.collections);
  for (const c of collections.items) {
    // Shopify-generated listings are not editable collections.
    if (["all", "vendors", "types"].includes(c.handle)) continue;
    const curl = `${base}/collections/${encodeURIComponent(c.handle)}`;
    checkSeo(collect, "collection", c, curl, duplicates);
    if (c.productsCount && c.productsCount.count === 0) collect.add("catalog.collection.empty", { url: curl, origin: "admin", evidence: `Collection "${c.title}" has no products` });
    if (c.image && !norm(c.image.altText)) collect.add("admin.collection-image.alt-missing", { url: curl, origin: "admin", evidence: `Collection "${c.title}": image has no alt text` });
  }
  return {
    productCounts,
    products: products.items.length,
    productsTruncated: products.truncated,
    collections: collections.items.length,
    collectionsTruncated: collections.truncated,
    sample: {
      products: products.items.slice(0, 3).map((p) => p.handle),
      collections: collections.items.filter((c) => !["all", "vendors", "types"].includes(c.handle)).slice(0, 2).map((c) => c.handle),
    },
  };
}

async function readThemeFiles(admin, themeId, filenames) {
  const data = await runGraphql(admin, THEME_FILE_QUERY, { id: themeId, filenames, first: filenames.length });
  const out = Object.fromEntries(filenames.map((f) => [f, null]));
  for (const n of data.theme?.files?.nodes || []) {
    if (typeof n.body?.content === "string") out[n.filename] = n.body.content;
  }
  return out;
}

// Checks the published theme. Anything that cannot be read or resolved is
// reported as "not checked", never as a finding.
async function auditTheme(admin, base, collect) {
  const themes = await listThemes(admin);
  const unpublished = themes.filter((t) => t.role === "UNPUBLISHED");
  if (unpublished.length >= 5) {
    collect.add("shopify.themes.unused", { url: `${base}/`, origin: "theme", evidence: `${unpublished.length} unpublished themes: ${unpublished.slice(0, 6).map((t) => t.name).join(", ")}` });
  }
  const live = themes.find((t) => t.role === "MAIN");
  if (!live) return { status: "unavailable", message: "The published theme could not be identified." };
  const layoutName = "layout/theme.liquid";
  const layout = (await readThemeFiles(admin, live.id, [layoutName]))[layoutName];
  if (layout === null) return { status: "unavailable", themeName: live.name, message: `${layoutName} could not be read.` };
  const notes = [];
  if (!THEME_PATCHES.theme_html_lang.check(layout)) {
    collect.add("seo.lang.missing", { url: `${base}/`, origin: "theme", evidence: `Published theme "${live.name}": <html> tag has no lang attribute` });
  }
  if (!/canonical/i.test(layout)) {
    const inc = headIncludes(layout);
    if (inc.unsupported.length) {
      notes.push(`Canonical tag not checked: the theme's <head> uses ${inc.unsupported.join(", ")}.`);
    } else {
      const files = inc.files.length ? await readThemeFiles(admin, live.id, inc.files.slice(0, 20)) : {};
      const contents = Object.values(files);
      if (contents.some((c) => c === null)) notes.push("Canonical tag not checked: a snippet rendered in <head> could not be read.");
      else if (!contents.some((c) => /canonical/i.test(c))) {
        collect.add("seo.canonical.missing", { url: `${base}/`, origin: "theme", evidence: `Published theme "${live.name}": no canonical link in layout or <head> snippets` });
      }
    }
  }
  const head = await headContents(admin, live.id, layout);
  if (head === null) {
    notes.push("Open Graph tags not checked: a snippet rendered in <head> could not be read.");
  } else if (!head.some((c) => /og:(title|image)/i.test(c))) {
    collect.add("seo.og.missing", { url: `${base}/`, origin: "theme", evidence: `Published theme "${live.name}": no og:title / og:image in layout or <head> snippets` });
  }
  const sd = await productStructuredData(admin, live.id, head);
  if (sd === false) {
    collect.add("seo.structured-data.missing", { url: `${base}/`, origin: "theme", evidence: `Published theme "${live.name}": product template outputs no structured data (no structured_data filter or JSON-LD)` });
  } else if (sd === null) {
    notes.push("Product structured data not checked: the product template could not be resolved.");
  }
  const favicon = await faviconSet(admin, live.id);
  if (favicon === false) {
    collect.add("shopify.favicon.missing", { url: `${base}/`, origin: "theme", evidence: `Published theme "${live.name}": no favicon in theme settings` });
  } else if (favicon === null) {
    notes.push("Favicon not checked: config/settings_data.json could not be read.");
  }
  return { status: "checked", themeName: live.name, notes };
}

// Layout plus the snippets it renders in <head>, or null if any cannot be read.
async function headContents(admin, themeId, layout) {
  const inc = headIncludes(layout);
  if (inc.unsupported.length) return null;
  const files = inc.files.length ? await readThemeFiles(admin, themeId, inc.files.slice(0, 20)) : {};
  const contents = Object.values(files);
  return contents.some((c) => c === null) ? null : [layout, ...contents];
}

const HAS_STRUCTURED_DATA = /structured_data|application\/ld\+json/i;

// true / false, or null when it cannot be decided. Looks at the product template's
// sections (JSON templates) or the Liquid template, and the snippets they render.
async function productStructuredData(admin, themeId, head) {
  if (head && head.some((c) => HAS_STRUCTURED_DATA.test(c))) return true;
  const t = await readThemeFiles(admin, themeId, ["templates/product.json", "templates/product.liquid"]);
  let files = [];
  if (t["templates/product.json"] !== null) {
    try {
      const json = JSON.parse(t["templates/product.json"].replace(/^\s*\/\*[\s\S]*?\*\//, ""));
      files = [...new Set(Object.values(json.sections || {}).map((s) => s?.type).filter((x) => typeof x === "string" && /^[\w-]+$/.test(x)))].map((x) => `sections/${x}.liquid`);
    } catch {
      return null;
    }
  } else if (t["templates/product.liquid"] !== null) {
    if (HAS_STRUCTURED_DATA.test(t["templates/product.liquid"])) return true;
    files = headIncludes(t["templates/product.liquid"], { headOnly: false }).files;
  } else {
    return null;
  }
  const sections = files.length ? await readThemeFiles(admin, themeId, files.slice(0, 20)) : {};
  const contents = Object.values(sections).filter((c) => c !== null);
  if (contents.some((c) => HAS_STRUCTURED_DATA.test(c))) return true;
  const nested = [...new Set(contents.flatMap((c) => headIncludes(c, { headOnly: false }).files))].slice(0, 20);
  const snippets = nested.length ? Object.values(await readThemeFiles(admin, themeId, nested)).filter((c) => c !== null) : [];
  return snippets.some((c) => HAS_STRUCTURED_DATA.test(c));
}

// true / false, or null when the settings cannot be read. settings_data.json may
// start with a comment and "current" may name a preset.
async function faviconSet(admin, themeId) {
  const name = "config/settings_data.json";
  const raw = (await readThemeFiles(admin, themeId, [name]))[name];
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw.replace(/^\s*\/\*[\s\S]*?\*\//, ""));
    const current = typeof data.current === "string" ? data.presets?.[data.current] : data.current;
    if (!current || typeof current !== "object") return null;
    return typeof current.favicon === "string" && current.favicon.trim() !== "";
  } catch {
    return null;
  }
}

async function auditStoreSetup(admin, base, host, collect) {
  const data = await runGraphql(admin, STORE_SETUP_QUERY);
  const passwordOn = data.onlineStore?.passwordProtection?.enabled === true;
  if (passwordOn) collect.add("shopify.store.password-protected", { url: `${base}/`, origin: "admin", evidence: "Online Store password protection is on" });
  const primary = String(data.shop?.primaryDomain?.host || host).toLowerCase();
  if (primary.endsWith(".myshopify.com")) collect.add("trust.domain.custom-missing", { url: `${base}/`, origin: "admin", evidence: `Primary domain is ${primary}` });
  return { status: "checked", passwordProtected: passwordOn };
}

const RESOURCE_TYPES_IN_MENUS = new Set(["PRODUCT", "COLLECTION", "PAGE", "BLOG", "ARTICLE"]);

async function auditContent(admin, base, collect, scopes, duplicates) {
  const result = { pages: null, articles: null, menus: null, notes: [] };
  const canPages = scopes.has("read_online_store_pages") && scopes.has("read_content");
  let pageHandles = null;
  if (canPages) {
    const pages = (await runGraphql(admin, SCAN_PAGES_QUERY, { first: AUDIT_LIMITS.pages })).pages?.nodes || [];
    const published = pages.filter((p) => p.isPublished);
    pageHandles = new Set(pages.map((p) => p.handle));
    for (const p of published) {
      checkSeo(collect, "page", p, `${base}/pages/${encodeURIComponent(p.handle)}`, duplicates, {
        title: p.titleTag?.value ?? null,
        description: p.descriptionTag?.value ?? null,
        fallbackDescription: p.bodySummary,
      });
    }
    if (!published.some((p) => /contact/i.test(p.handle))) {
      collect.add("trust.contact.missing", { url: `${base}/`, origin: "admin", evidence: `${published.length} published page(s), none with a contact handle` });
    }
    const articles = (await runGraphql(admin, SCAN_ARTICLES_QUERY, { first: AUDIT_LIMITS.articles })).articles?.nodes || [];
    for (const a of articles.filter((x) => x.isPublished)) {
      checkSeo(collect, "article", a, `${base}/blogs/${encodeURIComponent(a.blog?.handle || "news")}/${encodeURIComponent(a.handle)}`, duplicates, {
        title: a.titleTag?.value ?? null,
        description: a.descriptionTag?.value ?? null,
        fallbackDescription: a.summary,
      });
    }
    result.pages = published.length;
    result.articles = articles.length;
  } else {
    result.notes.push("Pages and blog posts not checked: the app needs the read_online_store_pages and read_content permissions.");
  }
  if (scopes.has("read_online_store_navigation")) {
    const menus = (await runGraphql(admin, MENUS_QUERY)).menus?.nodes || [];
    const flat = [];
    const walk = (items, menu) => {
      for (const it of items || []) {
        flat.push({ ...it, menu });
        walk(it.items, menu);
      }
    };
    for (const m of menus) walk(m.items, m.title);
    let lookups = 0;
    for (const it of flat) {
      let broken = false;
      if (RESOURCE_TYPES_IN_MENUS.has(it.type) && !it.resourceId) broken = true;
      else if (it.type === "HTTP" && it.url) {
        let u;
        try {
          u = new URL(it.url, base);
        } catch {
          continue;
        }
        if (u.origin !== base) continue;
        const [, kind, handle] = u.pathname.match(/^\/(products|collections|pages)\/([^/]+)\/?$/) || [];
        if (kind === "pages" && pageHandles) broken = !pageHandles.has(decodeURIComponent(handle));
        else if ((kind === "products" || kind === "collections") && !["all", "vendors", "types"].includes(handle) && lookups < AUDIT_LIMITS.menuLookups) {
          lookups++;
          broken = !(await lookupByHandle(admin, kind === "products" ? "product" : "collection", decodeURIComponent(handle)));
        }
      }
      if (broken) collect.add("links.menu-broken", { url: `${base}/`, origin: "admin", evidence: `Menu "${it.menu}": "${it.title}" → ${it.url || it.type}` });
    }
    result.menus = menus.length;
  } else {
    result.notes.push("Navigation menus not checked: the app needs the read_online_store_navigation permission.");
  }
  return result;
}

const REQUIRED_POLICIES = { PRIVACY_POLICY: "Privacy policy", REFUND_POLICY: "Refund policy", TERMS_OF_SERVICE: "Terms of service", SHIPPING_POLICY: "Shipping policy" };

async function auditPolicies(admin, base, collect, scopes) {
  if (!scopes.has("read_legal_policies")) {
    return {
      status: CHECK_STATUS.NOT_CHECKED,
      reason: "missing_scope",
      message: "Not checked: Shopify has not granted this app the read_legal_policies permission on this store yet. Approve the updated app permissions, then run the audit again.",
    };
  }
  let data;
  try {
    data = await runGraphql(admin, SHOP_POLICIES_QUERY);
  } catch (err) {
    if (!(err instanceof FixError)) throw err;
    if (err.code === "ACCESS_DENIED") {
      return { status: CHECK_STATUS.NOT_CHECKED, reason: "access_denied", message: "Not checked: Shopify denied access to store policies (permission not granted)." };
    }
    // A failed read is never treated as empty policies.
    return { status: CHECK_STATUS.ERROR, reason: err.code, message: `Store policies could not be read: ${err.message}` };
  }
  const present = new Set((data.shop?.shopPolicies || []).filter((x) => norm(String(x.body || "").replace(/<[^>]*>/g, ""))).map((x) => x.type));
  const missing = Object.keys(REQUIRED_POLICIES).filter((t) => !present.has(t));
  for (const t of missing) collect.add("trust.policies.missing", { url: `${base}/policies`, origin: "admin", evidence: `${REQUIRED_POLICIES[t]} is empty` });
  return { status: CHECK_STATUS.CHECKED, message: missing.length ? `${missing.length} standard policy page(s) are empty.` : "All standard policies have content." };
}

// Granted scopes as reported by Shopify; falls back to the stored session scopes.
async function grantedScopes(admin, sessionScopes) {
  try {
    const data = await runGraphql(admin, GRANTED_SCOPES_QUERY);
    const handles = (data.currentAppInstallation?.accessScopes || []).map((x) => x.handle).filter((h) => typeof h === "string");
    const set = new Set();
    for (const h of handles) {
      set.add(h);
      if (h.startsWith("write_")) set.add(`read_${h.slice(6)}`);
    }
    return { scopes: set, source: "shopify" };
  } catch (err) {
    if (!(err instanceof FixError)) throw err;
    return { scopes: sessionScopes, source: "session" };
  }
}

// ----- static storefront HTML checks

const count = (re, s) => (s.match(re) || []).length;

// Same-host page links (no fragments, files, or account/cart/checkout routes).
function internalLinks(html, pageHost) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    try {
      const u = new URL(m[1], `https://${pageHost}/`);
      if (u.protocol !== "https:" || u.hostname !== pageHost) continue;
      if (/^\/(cart|checkout|account|search|password|cdn)\b/.test(u.pathname) || /\.\w{2,5}$/.test(u.pathname)) continue;
      u.hash = "";
      u.search = "";
      out.add(u.toString());
    } catch {
      // ignore unparsable href
    }
  }
  return [...out];
}

export function analyzeHtml(html, pageHost) {
  const head = html.split(/<\/head\s*>/i)[0];
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const scripts = html.match(/<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>/gi) || [];
  const hosts = new Set();
  for (const s of scripts) {
    const src = s.match(/\bsrc\s*=\s*["']([^"']+)["']/i)[1];
    try {
      const h = new URL(src, `https://${pageHost}/`).hostname;
      if (h !== pageHost && !/(^|\.)(shopify\.com|shopifycdn\.net|shopifysvc\.com|myshopify\.com)$/.test(h)) hosts.add(h);
    } catch {
      // ignore unparsable src
    }
  }
  const headScripts = head.match(/<script\b[^>]*\bsrc\s*=[^>]*>/gi) || [];
  return {
    hasTitle: /<title[^>]*>\s*\S[\s\S]*?<\/title>/i.test(head),
    h1: count(/<h1\b/gi, html),
    imgsWithoutAlt: imgs.filter((t) => !/\salt\s*=/i.test(t)).length,
    hasOg: /<meta[^>]+property\s*=\s*["']og:(title|image)["']/i.test(head),
    hasJsonLd: /<script[^>]+type\s*=\s*["']application\/ld\+json["']/i.test(html),
    hasLang: /<html\b[^>]*\slang\s*=/i.test(html),
    hasCanonical: /<link[^>]+rel\s*=\s*["']canonical["']/i.test(head),
    blockingScripts: headScripts.filter((t) => !/\b(async|defer)\b/i.test(t) && !/type\s*=\s*["']module["']/i.test(t)).length,
    thirdPartyHosts: [...hosts],
    insecure: count(/\b(?:src|href)\s*=\s*["']http:\/\//gi, html),
    internalLinks: internalLinks(html, pageHost),
  };
}

// Minimal cookie jar: keeps name=value pairs from Set-Cookie headers.
function cookieJar() {
  const jar = new Map();
  return {
    add(setCookie) {
      for (const c of setCookie || []) {
        const pair = String(c).split(";")[0];
        const i = pair.indexOf("=");
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
  };
}

const isPasswordRedirect = (res) => res.status >= 300 && res.status < 400 && /\/password/.test(res.headers?.location || "");

// Submits the storefront password the merchant typed for this run. The password
// is only sent to the shop's own /password page and is never stored or logged.
// Returns { ok, reason } where reason is "rejected", "blocked" or "no_form".
export function passwordForm(html) {
  const form = (String(html).match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || []).find((f) => /<input\b[^>]*\bname\s*=\s*["']password["']/i.test(f));
  if (!form) return null;
  const fields = new URLSearchParams();
  for (const input of form.match(/<input\b[^>]*>/gi) || []) {
    if (!/\btype\s*=\s*["']hidden["']/i.test(input)) continue;
    const name = input.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
    const value = input.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    if (name) fields.set(name, value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x2F;/gi, "/").replace(/&#43;|&#x2B;/gi, "+").replace(/&#61;|&#x3D;/gi, "="));
  }
  const action = form.match(/<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/i)?.[1] || "/password";
  return { fields, action: action.startsWith("/") && !action.startsWith("//") ? action : "/password" };
}

async function unlockStorefront({ request, base, allowedHosts, password, jar }) {
  const opts = { allowedHosts, maxRedirects: 0, timeoutMs: 8000, maxBytes: 500_000 };
  const browserish = { accept: "text/html", "user-agent": "StoreAudit-InApp/1.0" };
  const page = await request(`${base}/password`, { ...opts, headers: { ...browserish, cookie: jar.header() } });
  if (page.skipped) return { ok: false, reason: page.stopped.kind === "rate_limited" ? "rate_limited" : "blocked" };
  jar.add(page.headers?.setCookie);
  if (page.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
  if (page.status === 403) return { ok: false, reason: "blocked", status: 403 };
  const form = passwordForm(page.text || "");
  if (!form) return { ok: false, reason: "no_form", status: page.status };
  form.fields.set("password", password);
  const res = await request(`${base}${form.action}`, {
    ...opts,
    method: "POST",
    body: form.fields.toString(),
    headers: {
      ...browserish,
      "content-type": "application/x-www-form-urlencoded",
      origin: base,
      referer: `${base}/password`,
      cookie: jar.header(),
    },
  });
  if (res.skipped) return { ok: false, reason: res.stopped.kind === "rate_limited" ? "rate_limited" : "blocked" };
  jar.add(res.headers?.setCookie);
  if (res.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
  if (res.status === 403 || res.status >= 500) return { ok: false, reason: "blocked", status: res.status };
  const home = await request(`${base}/`, { ...opts, headers: { ...browserish, cookie: jar.header() } });
  if (home.skipped) return { ok: false, reason: home.stopped.kind === "rate_limited" ? "rate_limited" : "blocked" };
  jar.add(home.headers?.setCookie);
  if (home.status === 200) return { ok: true };
  if (home.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
  return { ok: false, reason: isPasswordRedirect(home) ? "rejected" : "blocked", status: home.status };
}

const UNLOCK_MESSAGES = {
  rejected: "Shopify did not accept the storefront password. Check it in Online Store > Preferences > Password protection and run the audit again.",
  blocked: "Shopify refused the automated password login (HTTP 403 or a server error). The storefront protects itself against automated traffic; this is not a wrong password.",
  rate_limited: "Shopify rate limited the app's requests (HTTP 429) during the password login. Try again in a few minutes.",
  no_form: "The storefront's password page has no password form the app could recognise.",
};

function metaContent(head, name) {
  const tag = head.match(new RegExp(`<meta[^>]+name\\s*=\\s*["']${name}["'][^>]*>`, "i"))?.[0];
  return tag?.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i)?.slice(1).find((x) => x !== undefined) ?? null;
}

const STOP_STATUS = { rate_limited: CHECK_STATUS.RATE_LIMITED, blocked: CHECK_STATUS.BLOCKED, budget: CHECK_STATUS.PARTIAL, error: CHECK_STATUS.ERROR };

function stopMessage(stopped) {
  const via = stopped.server ? ` (answered by "${stopped.server}")` : "";
  if (stopped.kind === "rate_limited") {
    return `Shopify rate limited the app's storefront requests (HTTP 429${stopped.retryAfter ? `, Retry-After ${stopped.retryAfter}` : ""})${via}. The app retried a limited number of times and then stopped.`;
  }
  if (stopped.kind === "blocked") return `The storefront refused the app's requests (HTTP 403)${via}. Storefronts can block automated traffic; the app does not try to get around it.`;
  if (stopped.kind === "budget") return "The storefront request limit for one audit was reached.";
  return `The storefront returned an error (HTTP ${stopped.status ?? "?"}).`;
}

// `session.cookieHeader` is set after a successful password login so the local
// Lighthouse run can open the same unlocked storefront. It is never put in the report.
async function auditStorefront({ fetchPage, host, allowedHosts, base, sample, password, session = {}, clientOptions = {} }, collect) {
  const jar = cookieJar();
  const client = createStorefrontClient({ fetchPage, ...clientOptions });
  const opts = { allowedHosts, maxRedirects: 0, timeoutMs: 8000, maxBytes: 2_000_000 };
  const headers = () => ({ accept: "text/html", "user-agent": "StoreAudit-InApp/1.0", ...(jar.header() ? { cookie: jar.header() } : {}) });
  // Follows up to 2 redirects that stay on an allowed host and do not lead to the
  // password page. Every hop goes through fetchPage again, so it is re-validated.
  async function get(url, maxBytes = opts.maxBytes) {
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await client.request(current, { ...opts, maxBytes, headers: headers() });
      if (res.skipped || !(res.status >= 300 && res.status < 400) || isPasswordRedirect(res) || hop >= 2) return { ...res, finalUrl: current };
      let next;
      try {
        next = new URL(res.headers?.location || "", current);
      } catch {
        return { ...res, finalUrl: current };
      }
      if (next.protocol !== "https:" || !allowedHosts.includes(next.hostname.toLowerCase())) return { ...res, finalUrl: current, offsite: true };
      next.hash = "";
      current = next.toString();
    }
  }
  const paths = ["/", ...sample.products.map((h) => `/products/${encodeURIComponent(h)}`), ...sample.collections.map((h) => `/collections/${encodeURIComponent(h)}`)].slice(0, AUDIT_LIMITS.storefrontPages);
  const pages = [];
  const links = new Map();
  let unlocked = false;
  const result = (status, message) => ({ status, message, pages, requests: client.stats(), stopped: client.stopped ? { kind: client.stopped.kind, status: client.stopped.status, server: client.stopped.server } : null });
  for (const path of paths) {
    const url = `${base}${path}`;
    let res;
    try {
      res = await get(url);
      if (!res.skipped && isPasswordRedirect(res) && password && !unlocked) {
        const u = await unlockStorefront({ request: client.request, base, allowedHosts, password, jar });
        if (!u.ok) {
          const status = u.reason === "rate_limited" ? CHECK_STATUS.RATE_LIMITED : u.reason === "blocked" ? CHECK_STATUS.BLOCKED : CHECK_STATUS.NOT_CHECKED;
          return result(status, `${UNLOCK_MESSAGES[u.reason]} Storefront page checks were skipped; the rest of the audit still ran.`);
        }
        unlocked = true;
        session.cookieHeader = jar.header();
        res = await get(url);
      }
    } catch {
      return result(pages.length ? CHECK_STATUS.PARTIAL : CHECK_STATUS.ERROR, "The storefront could not be reached (network error or timeout).");
    }
    if (res.skipped) break;
    if (isPasswordRedirect(res)) {
      return result(
        CHECK_STATUS.NOT_CHECKED,
        password
          ? "The storefront still showed the password page after logging in, so storefront page checks were skipped."
          : "The storefront is password protected, so storefront page checks were skipped. Enter the storefront password when running the audit to check the real pages. The rest of the audit still ran.",
      );
    }
    if (res.status === 429 || res.status === 403) break; // the client has stopped
    if (res.status !== 200) continue; // a missing sample page is not a storefront failure
    pages.push(url);
    const a = analyzeHtml(res.text, host);
    const add = (id, evidence) => collect.add(id, { url, origin: "storefront", evidence: `${path}: ${evidence}` });
    if (!a.hasTitle) add("seo.title.missing", "no <title>");
    if (a.h1 === 0) add("seo.h1.missing", "no <h1>");
    if (a.h1 > 1) add("seo.h1.multiple", `${a.h1} <h1> elements`);
    if (a.imgsWithoutAlt) add("seo.img.alt-missing", `${a.imgsWithoutAlt} <img> without alt`);
    if (!a.hasOg) add("seo.og.missing", "no og:title / og:image");
    if (!a.hasJsonLd) add("seo.structured-data.missing", "no JSON-LD");
    if (!a.hasLang) add("seo.lang.missing", "<html> has no lang");
    if (!a.hasCanonical) add("seo.canonical.missing", "no canonical link in <head>");
    if (a.blockingScripts) add("code.render-blocking", `${a.blockingScripts} blocking script(s) in <head>`);
    if (a.thirdPartyHosts.length > 8) add("shopify.app-bloat", `${a.thirdPartyHosts.length} third-party script hosts (${a.thirdPartyHosts.slice(0, 6).join(", ")}…)`);
    if (a.insecure) add("trust.mixed-content", `${a.insecure} http:// resource reference(s)`);
    // Homepage SEO lives in Online Store > Preferences, which Admin data checks do not cover.
    if (path === "/") {
      const head = res.text.split(/<\/head\s*>/i)[0];
      const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
      if (title && (title.length < 15 || title.length > 65)) add("seo.title.length", `homepage title is ${title.length} characters ("${title.slice(0, 70)}")`);
      const description = (metaContent(head, "description") || "").trim();
      if (!description) add("seo.meta-description.missing", "homepage has no meta description");
      else if (description.length < 50 || description.length > 165) add("seo.meta-description.length", `homepage meta description is ${description.length} characters`);
    }
    for (const [rule, samples] of Object.entries(accessibilityIssues(scanHtml(res.text)))) {
      add(`a11y.${rule}`, `${samples.count || samples.length} element(s): ${samples.join(", ")}`);
    }
    for (const href of a.internalLinks) if (!links.has(href)) links.set(href, path);
  }
  if (!pages.length) {
    if (client.stopped) return result(STOP_STATUS[client.stopped.kind] || CHECK_STATUS.ERROR, `${stopMessage(client.stopped)} Storefront page checks were skipped; the rest of the audit still ran.`);
    return result(CHECK_STATUS.ERROR, "No storefront page could be loaded.");
  }
  // Internal links found on the checked pages, bounded. Only 404 and 410 mean a
  // broken link; rate limiting, blocking and server errors are not link defects.
  let checkedLinks = 0;
  let unconfirmed = 0;
  for (const [href, from] of [...links.entries()].slice(0, AUDIT_LIMITS.linkChecks)) {
    if (pages.includes(href)) continue;
    if (client.stopped) {
      unconfirmed++;
      continue;
    }
    try {
      const r = await get(href, 50_000);
      if (r.skipped) {
        unconfirmed++;
        continue;
      }
      checkedLinks++;
      if (r.status === 404 || r.status === 410) {
        collect.add("links.broken", { url: `${base}${from}`, origin: "storefront", evidence: `${from} links to ${new URL(href).pathname} (HTTP ${r.status})` });
      } else if (r.status >= 400) {
        unconfirmed++;
      }
    } catch {
      unconfirmed++; // our side may be the cause; not a broken link
    }
  }
  const base_ = `${pages.length} storefront page(s) checked as static HTML${unlocked ? " (unlocked with the password you entered)" : ""}, ${checkedLinks} internal link(s) tested${unconfirmed ? `, ${unconfirmed} link(s) could not be confirmed` : ""}.`;
  if (client.stopped) return result(CHECK_STATUS.PARTIAL, `${base_} ${stopMessage(client.stopped)} Remaining storefront checks were skipped.`);
  return result(CHECK_STATUS.CHECKED, base_);
}

/**
 * Runs the audit. Returns { findings, report } in the importer's shapes.
 * `shopInfo` comes from the authenticated Admin API.
 */
export async function runAudit({
  admin,
  shopInfo,
  scopes = new Set(),
  includeStorefront = true,
  storefrontPassword = null,
  fetchPage = safeFetchText,
  pagespeedFetch = fetch,
  lighthouseRun = undefined,
  env = process.env,
  storefrontClientOptions = {},
}) {
  const host = (shopInfo.primaryDomainHost || shopInfo.myshopifyDomain).toLowerCase();
  const base = `https://${host}`;
  const collect = createCollector();
  const startedAt = new Date();

  const granted = await grantedScopes(admin, scopes);
  scopes = granted.scopes;
  const duplicates = createDuplicateTracker();
  const adminScan = await auditAdminData(admin, base, collect, duplicates);
  let setup;
  try {
    setup = await auditStoreSetup(admin, base, host, collect);
  } catch {
    setup = { status: "unavailable" };
  }
  let content;
  try {
    content = await auditContent(admin, base, collect, scopes, duplicates);
  } catch (err) {
    if (!(err instanceof FixError)) throw err;
    const denied = err.code === "ACCESS_DENIED";
    content = {
      pages: null,
      articles: null,
      menus: null,
      notes: [denied ? "Pages, blog posts and menus not checked: Shopify denied access (permission not granted)." : `Pages, blog posts and menus could not be read: ${err.message}`],
    };
  }
  duplicates.report(collect);
  let theme;
  try {
    theme = await auditTheme(admin, base, collect);
  } catch {
    theme = { status: "unavailable", message: "The published theme could not be read." };
  }
  const policies = await auditPolicies(admin, base, collect, scopes);
  let storefront = { status: "skipped", message: "Storefront page checks were not requested.", pages: [] };
  const session = {};
  if (includeStorefront) {
    const allowedHosts = [...new Set([host, String(shopInfo.myshopifyDomain || "").toLowerCase()].filter(Boolean))];
    storefront = await auditStorefront({ fetchPage, host, allowedHosts, base, sample: adminScan.sample, password: storefrontPassword || null, session, clientOptions: storefrontClientOptions }, collect);
  }

  // Speed, rendered accessibility and console errors: measured by Google, or by
  // a local Lighthouse run when the store is password protected and was unlocked.
  let performance;
  if (!includeStorefront) {
    performance = { status: CHECK_STATUS.NOT_CHECKED, message: "Not requested (storefront checks were turned off).", findings: [] };
  } else if (setup.passwordProtected && session.cookieHeader) {
    performance = await measureHomepageLocally({ url: `${base}/`, cookieHeader: session.cookieHeader, env, runImpl: lighthouseRun });
  } else if (setup.passwordProtected) {
    performance = {
      status: CHECK_STATUS.NOT_CHECKED,
      message: storefrontPassword
        ? "Not measured: the store is password protected and the password login did not succeed (see the storefront section)."
        : "Not measured: the store is password protected. Enter the storefront password when running the audit so the app can log in and measure it.",
      findings: [],
    };
  } else {
    performance = await measureHomepage({ url: `${base}/`, env, fetchImpl: pagespeedFetch });
  }
  for (const f of performance.findings || []) {
    collect.add(f.id, { url: `${base}/`, origin: "pagespeed", evidence: f.evidence, severity: f.severity, title: f.title || null });
  }
  // eslint-disable-next-line no-unused-vars
  const { findings: _psiFindings, ...performanceReport } = performance;

  const findings = collect.findings();
  // A category is scored only when its main checks actually ran. Rate-limited,
  // blocked or failed measurements deduct nothing and are listed in coverage.
  const storefrontChecked = [CHECK_STATUS.CHECKED, CHECK_STATUS.PARTIAL].includes(storefront.status);
  const speedChecked = performance.status === CHECK_STATUS.CHECKED;
  const score = scoreAudit(findings, {
    seo: true,
    // Product image alt text alone is not an accessibility audit.
    accessibility: storefrontChecked || speedChecked,
    performance: storefrontChecked || speedChecked,
    links: storefrontChecked || content.menus !== null,
    shopify: theme.status === "checked",
    trust: policies.status === CHECK_STATUS.CHECKED || storefrontChecked,
  });
  return {
    host,
    startedAt,
    findings,
    report: {
      origin: "in-app",
      crawledAt: startedAt,
      device: null,
      pagesCrawled: storefront.pages,
      metrics: null,
      narrative: null,
      summaryNotes: [],
      unsupported: [],
      scan: {
        productCounts: adminScan.productCounts,
        products: adminScan.products,
        productsTruncated: adminScan.productsTruncated,
        collections: adminScan.collections,
        collectionsTruncated: adminScan.collectionsTruncated,
        limits: AUDIT_LIMITS,
      },
      theme,
      policies,
      setup,
      content,
      storefront: { status: storefront.status, message: storefront.message, requests: storefront.requests ?? null, stopped: storefront.stopped ?? null },
      performance: performanceReport,
      grantedScopesSource: granted.source,
      score,
      coverage: coverageOf({ adminScan, theme, policies, storefront, content, performance }),
    },
  };
}

// What the audit could and could not check, with the reason. Statuses come from
// CHECK_STATUS; anything other than "checked" is shown to the merchant.
function coverageOf({ adminScan, theme, policies, storefront, content, performance }) {
  const items = [];
  for (const note of content.notes || []) items.push({ area: note.split(" not checked")[0].split(" could not")[0], status: CHECK_STATUS.NOT_CHECKED, reason: note });
  const pc = adminScan.productCounts;
  if (adminScan.products === 0) {
    items.push({
      area: "Products",
      status: CHECK_STATUS.NOT_CHECKED,
      reason: pc && pc.all ? `The store has ${pc.all} product(s) but none are active (${pc.draft ?? 0} draft). Only active products are audited.` : "The store has no active products.",
    });
  }
  if (storefront.status !== CHECK_STATUS.CHECKED) {
    const status = storefront.status === "skipped" ? CHECK_STATUS.NOT_CHECKED : storefront.status;
    items.push({ area: "Storefront pages (homepage SEO, accessibility, links, speed-related code)", status, reason: storefront.message });
  }
  if (policies.status !== CHECK_STATUS.CHECKED) items.push({ area: "Store policies", status: policies.status, reason: policies.message });
  if (theme.status !== "checked") items.push({ area: "Published theme", status: CHECK_STATUS.ERROR, reason: theme.message });
  if (performance.status !== CHECK_STATUS.CHECKED) {
    items.push({ area: "Speed, colour contrast, JavaScript errors", status: performance.status, reason: performance.message });
  }
  return items;
}

// ----- score

export const SCORE_WEIGHTS = { critical: 25, high: 15, medium: 8, low: 3 };
export const CATEGORY_LABELS = { seo: "SEO", accessibility: "Accessibility", performance: "Speed and code", links: "Links", shopify: "Shopify setup", trust: "Trust" };

/**
 * Transparent score: each checked category starts at 100 and loses a fixed
 * number of points per finding by severity (not per page), floored at 0. The
 * overall score is the average of the categories that were actually checked.
 */
export function scoreAudit(findings, checked) {
  const categories = {};
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    const own = findings.filter((f) => f.category === key);
    categories[key] = checked[key]
      ? { key, label, score: Math.max(0, 100 - own.reduce((n, f) => n + SCORE_WEIGHTS[f.severity], 0)), count: own.length }
      : { key, label, score: null, count: own.length };
  }
  const scored = Object.values(categories).filter((c) => c.score !== null);
  const overall = scored.length ? Math.round(scored.reduce((n, c) => n + c.score, 0) / scored.length) : null;
  const grade = overall === null ? null : overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "F";
  return { overall, grade, categories, weights: SCORE_WEIGHTS };
}
