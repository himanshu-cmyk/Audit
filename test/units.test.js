/* eslint-env node */
import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { STORE_MATCH } from "../app/fixes/constants";
import { FIELD_RULES, suggestSeoDescription, suggestSeoTitle, validateTextValue } from "../app/fixes/content.server";
import { FixError, runGraphql } from "../app/fixes/graphql.server";
import { THEME_PATCHES, headIncludes } from "../app/fixes/handlers/themePatches.server";
import {
  classifyFinding,
  eligibilityProblems,
  getFixType,
  grantedScopes,
  themeWritesStatus,
} from "../app/fixes/registry.server";
import { classifyStoreUrl } from "../app/fixes/resolve.server";
import { canModifyStore, evaluateStoreMatch, validateStoreConfirmation } from "../app/fixes/storeMatch.server";
import { DEFAULT_SCOPES, graphqlQueryError } from "./helpers/fakeShopify";

describe("store matching", () => {
  const info = { myshopifyDomain: "acme.myshopify.com", primaryDomainHost: "www.acme.com" };
  it("matches primary domain with or without www", () => {
    expect(evaluateStoreMatch("acme.com", "acme.myshopify.com", info).status).toBe(STORE_MATCH.MATCHED);
    expect(evaluateStoreMatch("www.acme.com", "acme.myshopify.com", info).status).toBe(STORE_MATCH.MATCHED);
    expect(evaluateStoreMatch("acme.myshopify.com", "acme.myshopify.com", info).status).toBe(STORE_MATCH.MATCHED);
  });
  it("flags other domains and missing domains", () => {
    expect(evaluateStoreMatch("other-store.com", "acme.myshopify.com", info).status).toBe(STORE_MATCH.MISMATCH);
    expect(evaluateStoreMatch(null, "acme.myshopify.com", info).status).toBe(STORE_MATCH.UNKNOWN);
    expect(evaluateStoreMatch("fixture", "acme.myshopify.com", info).status).toBe(STORE_MATCH.UNKNOWN);
  });
  it("requires an explicit, exact confirmation for mismatches and never for unknown", () => {
    const mismatch = { storeMatch: STORE_MATCH.MISMATCH, auditedHost: "acme-old.com" };
    expect(validateStoreConfirmation(mismatch, "acme-old.com", false)).toMatch(/Tick/);
    expect(validateStoreConfirmation(mismatch, "evil.com", true)).toMatch(/exactly/);
    expect(validateStoreConfirmation(mismatch, "www.acme-old.com", true)).toBeNull();
    expect(validateStoreConfirmation({ storeMatch: STORE_MATCH.UNKNOWN }, "x.com", true)).toMatch(/does not need/);
    expect(canModifyStore(mismatch)).toBe(false);
    expect(canModifyStore({ ...mismatch, storeConfirmedAt: new Date() })).toBe(true);
    expect(canModifyStore({ storeMatch: STORE_MATCH.UNKNOWN, storeConfirmedAt: new Date() })).toBe(false);
  });
});

describe("storefront URL resolution", () => {
  const host = "www.acme.com";
  it("classifies product, collection and nested product URLs", () => {
    expect(classifyStoreUrl("https://www.acme.com/products/blue-shirt", host)).toEqual({ kind: "product", handle: "blue-shirt", locale: null });
    expect(classifyStoreUrl("https://acme.com/collections/summer/products/blue-shirt", host)).toEqual({ kind: "product", handle: "blue-shirt", locale: null, viaCollection: "summer" });
    expect(classifyStoreUrl("https://www.acme.com/collections/summer", host)).toEqual({ kind: "collection", handle: "summer", locale: null });
    expect(classifyStoreUrl("https://www.acme.com/en-gb/products/blue-shirt?variant=1", host)).toEqual({ kind: "product", handle: "blue-shirt", locale: "en-gb" });
    expect(classifyStoreUrl("https://www.acme.com/fr/collections/summer/products/blue-shirt", host)).toMatchObject({ kind: "product", handle: "blue-shirt", locale: "fr" });
  });
  it("treats Shopify-generated listings, feeds and odd paths conservatively", () => {
    for (const path of ["collections/all", "collections/vendors?q=Acme", "collections/types?q=Juice", "collections/ALL"]) {
      expect(classifyStoreUrl(`https://www.acme.com/${path}`, host).kind).toBe("special");
    }
    // A product reached through /collections/all is still that product.
    expect(classifyStoreUrl("https://www.acme.com/collections/all/products/blue-shirt", host)).toMatchObject({ kind: "product", handle: "blue-shirt" });
    expect(classifyStoreUrl("https://www.acme.com/products/blue-shirt.json", host).kind).toBe("file");
    expect(classifyStoreUrl("https://www.acme.com/collections/summer.atom", host).kind).toBe("file");
    expect(classifyStoreUrl("https://www.acme.com/products/a/b", host).kind).toBe("ambiguous");
    expect(classifyStoreUrl("https://www.acme.com/products", host).kind).toBe("ambiguous");
    expect(classifyStoreUrl("https://www.acme.com/xx/pages/about", host).kind).toBe("page");
  });
  it("marks unsupported page types as manual and ignores other hosts", () => {
    expect(classifyStoreUrl("https://www.acme.com/", host).kind).toBe("home");
    expect(classifyStoreUrl("https://www.acme.com/pages/about", host).kind).toBe("page");
    expect(classifyStoreUrl("https://www.acme.com/cart", host).kind).toBe("cart");
    expect(classifyStoreUrl("https://evil.com/products/blue-shirt", host).kind).toBe("foreign");
    expect(classifyStoreUrl("javascript:alert(1)", host).kind).toBe("invalid");
    expect(classifyStoreUrl("https://www.acme.com/products/%E0%A4%A", host).kind).toBe("invalid");
  });
});

describe("content validation and suggestions", () => {
  it("rejects HTML, Liquid, empty, unchanged and over-length values", () => {
    const r = FIELD_RULES.seoTitle;
    expect(validateTextValue("<b>Sale</b>", r).errors.join()).toMatch(/HTML/);
    expect(validateTextValue("{{ shop.name }}", r).errors.join()).toMatch(/Liquid/);
    expect(validateTextValue("   ", r).ok).toBe(false);
    expect(validateTextValue("x".repeat(71), r).ok).toBe(false);
    expect(validateTextValue("Same", r, { previous: "Same" }).errors.join()).toMatch(/unchanged/);
    expect(validateTextValue(123, r).ok).toBe(false);
    expect(validateTextValue("Organic Juice | Acme Store Natural Products", r).ok).toBe(true);
  });
  it("warns about keyword stuffing", () => {
    const v = validateTextValue("juice juice juice juice best juice", FIELD_RULES.seoDescription);
    expect(v.warnings.join()).toMatch(/keyword stuffing/);
  });
  it("only rephrases existing text and never invents content", () => {
    const description = "Cold pressed karela and jamun juice in a 500 ml bottle. Contains no added sugar. Store in a cool, dry place away from sunlight and shake well before every use, then refrigerate after opening.";
    const s = suggestSeoDescription({ currentSeoDescription: null, plainDescription: description });
    expect(description.startsWith(s.value.replace(/…$/, ""))).toBe(true);
    expect(s.value.length).toBeLessThanOrEqual(160);
    expect(suggestSeoDescription({ currentSeoDescription: null, plainDescription: "" }).value).toBe("");
    const t = suggestSeoTitle({ resourceTitle: "Karela Jamun Juice", currentSeoTitle: null, shopName: "Acme" });
    expect(t.value).toBe("Karela Jamun Juice | Acme");
    expect(suggestSeoTitle({ resourceTitle: "A".repeat(10) + " " + "B".repeat(70), shopName: "" }).value.length).toBeLessThanOrEqual(60);
  });
});

describe("theme patches are deterministic and refuse ambiguity", () => {
  const lang = THEME_PATCHES.theme_html_lang;
  const canonical = THEME_PATCHES.theme_canonical_tag;
  it("adds the lang attribute to a single html tag", () => {
    const r = lang.apply('<!doctype html>\n<html class="no-js">\n<head></head></html>');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('<html lang="{{ request.locale.iso_code }}" class="no-js">');
    expect(lang.check(r.content)).toBe(true);
  });
  it("refuses missing, multiple or already-present html lang", () => {
    expect(lang.apply("<head></head>").ok).toBe(false);
    expect(lang.apply("<html><html>").ok).toBe(false);
    expect(lang.apply('<html lang="en">').reason).toMatch(/already has a lang/);
  });
  it("adds a canonical tag once and refuses duplicates or ambiguous anchors", () => {
    const r = canonical.apply("<html>\n  <head>\n    <title>x</title>\n  </head>\n</html>");
    expect(r.ok).toBe(true);
    expect(r.content).toContain('<link rel="canonical" href="{{ canonical_url }}">');
    expect(canonical.check(r.content)).toBe(true);
    expect(canonical.apply('<head><link rel="canonical" href="{{ canonical_url }}"></head>').ok).toBe(false);
    expect(canonical.apply("<head></head><head></head>").ok).toBe(false);
  });
});

describe("head include inspection", () => {
  it("finds files rendered in <head> and flags what cannot be resolved", () => {
    const layout = "<html><head>{%- render 'meta-tags' -%}{% section 'header' %}{% render var %}{% sections 'header-group' %}</head><body>{% render 'footer' %}</body></html>";
    const r = headIncludes(layout);
    expect(r.files).toEqual(["snippets/meta-tags.liquid", "sections/header.liquid"]);
    expect(r.unsupported).toEqual(["render var", "sections 'header-group'"]);
  });
});

describe("finding classification", () => {
  const f = (auditId) => ({ auditId, audit: null });
  it("separates automatic, manual-review and manual findings", () => {
    expect(classifyFinding(f("seo.meta-description.length")).status).toBe("auto");
    expect(classifyFinding(f("seo.meta-description.length")).changeScopes).toEqual(["admin_shared"]);
    expect(classifyFinding(f("a11y.image-alt")).status).toBe("manual_review");
    expect(classifyFinding(f("seo.title.missing")).status).toBe("manual");
    expect(classifyFinding(f("seo.title.missing")).reason).toMatch(/theme/);
    expect(classifyFinding(f("perf.cwv.lcp")).status).toBe("manual");
    expect(classifyFinding(f("seo.lang.missing")).changeScopes).toEqual(["theme_unpublished"]);
  });
});

describe("fix registry and permissions", () => {
  it("rejects unknown and prototype-polluting fix types", () => {
    for (const t of ["run_shell", "__proto__", "constructor", "", null]) {
      expect(() => getFixType(t)).toThrowError(FixError);
    }
  });
  it("derives granted scopes and blocks missing permissions", () => {
    expect(grantedScopes({ scope: DEFAULT_SCOPES }).has("read_products")).toBe(true);
    const def = getFixType("product_seo_title");
    const imp = { storeMatch: STORE_MATCH.MATCHED };
    expect(eligibilityProblems(def, { session: { scope: DEFAULT_SCOPES }, importRecord: imp })).toEqual([]);
    expect(eligibilityProblems(def, { session: { scope: "read_products" }, importRecord: imp }).join()).toMatch(/write_products/);
    expect(eligibilityProblems(def, { session: { scope: DEFAULT_SCOPES }, importRecord: { storeMatch: STORE_MATCH.MISMATCH } }).join()).toMatch(/not confirmed/);
  });
  it("keeps theme writes disabled unless the scope and the exemption flag are both present", () => {
    expect(themeWritesStatus({ scope: DEFAULT_SCOPES }, {}).enabled).toBe(false);
    expect(themeWritesStatus({ scope: "write_products" }, { THEME_WRITES_ENABLED: "true" }).enabled).toBe(false);
    expect(themeWritesStatus({ scope: DEFAULT_SCOPES }, { THEME_WRITES_ENABLED: "true" }).enabled).toBe(true);
  });
  it("never references theme publishing anywhere in the fix system", () => {
    const dir = path.join(__dirname, "../app/fixes");
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(js|jsx)$/.test(f));
    for (const f of files) {
      expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toMatch(/themePublish/);
    }
  });
});

describe("GraphQL wrapper", () => {
  const ok = (data) => new Response(JSON.stringify({ data }));
  it("retries throttled requests and then succeeds", async () => {
    const admin = { graphql: vi.fn().mockRejectedValueOnce(graphqlQueryError(["Throttled"], "THROTTLED")).mockResolvedValueOnce(ok({ x: 1 })) };
    const sleep = vi.fn(async () => {});
    await expect(runGraphql(admin, "query A { x }", {}, { sleep })).resolves.toEqual({ x: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it("maps GraphQL errors, expired sessions and network errors to FixError", async () => {
    await expect(runGraphql({ graphql: async () => { throw graphqlQueryError(["Field 'x' doesn't exist"]); } }, "query A { x }")).rejects.toMatchObject({ code: "GRAPHQL_ERROR" });
    await expect(runGraphql({ graphql: async () => { throw new Response("", { status: 401 }); } }, "query A { x }")).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(runGraphql({ graphql: async () => { throw graphqlQueryError(["denied"], "ACCESS_DENIED"); } }, "query A { x }")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(runGraphql({ graphql: async () => { throw new TypeError("fetch failed"); } }, "query A { x }")).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });
  });
  it("does not enable client retries for mutations", async () => {
    const admin = { graphql: vi.fn(async () => ok({ y: 1 })) };
    await runGraphql(admin, "mutation M { y }", {}, { mutation: true });
    expect(admin.graphql.mock.calls[0][1]).not.toHaveProperty("tries");
  });
});
