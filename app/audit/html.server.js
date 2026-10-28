// Static HTML checks for the in-app audit. A small tag scanner (no dependency, no
// script execution) keeps track of open elements so rules can look at
// ancestors and accessible text. It works on server-rendered HTML only: content
// added by JavaScript, and anything that needs layout (colour contrast, focus
// order), cannot be checked here.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const NAMED = new Set(["a", "button", "label", "title", "h1"]);

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

/** Elements in document order: { tag, attrs, ancestors: string[], text (for NAMED tags) }. */
export function scanHtml(html) {
  const clean = String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    // Raw-text elements: their content is not markup the user sees.
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const elements = [];
  const stack = [];
  const re = /<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[3] !== undefined) {
      const text = m[3].replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
      if (text.trim()) for (const el of stack) if (el.text !== undefined) el.text += text;
      continue;
    }
    const tag = m[1].toLowerCase();
    if (m[0].startsWith("</")) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const attrs = parseAttrs(m[2] || "");
    const el = { tag, attrs, ancestors: stack.map((e) => e.tag) };
    if (NAMED.has(tag)) el.text = "";
    // Image alt text counts as the accessible name of a link or button around it.
    if (tag === "img" && attrs.alt) for (const open of stack) if (open.text !== undefined) open.text += ` ${attrs.alt}`;
    elements.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[2] || "")) stack.push(el);
  }
  return elements;
}

// HTML autocomplete tokens (WHATWG), plus section-* / shipping / billing prefixes.
const AUTOCOMPLETE = new Set(
  "on off name honorific-prefix given-name additional-name family-name honorific-suffix nickname username new-password current-password one-time-code organization-title organization street-address address-line1 address-line2 address-line3 address-level4 address-level3 address-level2 address-level1 country country-name postal-code cc-name cc-given-name cc-additional-name cc-family-name cc-number cc-exp cc-exp-month cc-exp-year cc-csc cc-type transaction-currency transaction-amount language bday bday-day bday-month bday-year sex url photo tel tel-country-code tel-national tel-area-code tel-local tel-local-prefix tel-local-suffix tel-extension email impp webauthn".split(" "),
);
const AUTOCOMPLETE_PREFIX = /^(section-\S+\s+)?((shipping|billing)\s+)?((home|work|mobile|fax|pager)\s+)?/;

export function validAutocomplete(value) {
  const v = String(value).trim().toLowerCase();
  if (!v) return true;
  const rest = v.replace(AUTOCOMPLETE_PREFIX, "");
  return AUTOCOMPLETE.has(rest);
}

const hasName = (el) => Boolean((el.text || "").trim() || el.attrs["aria-label"]?.trim() || el.attrs["aria-labelledby"]?.trim() || el.attrs.title?.trim());

const describe = (el) => `<${el.tag}${el.attrs.id ? `#${el.attrs.id}` : ""}${el.attrs.class ? `.${el.attrs.class.trim().split(/\s+/)[0]}` : ""}${el.attrs.name ? ` name="${el.attrs.name}"` : ""}>`;

const LABELLED_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

/**
 * Accessibility rules that can be decided from static HTML. Returns
 * { [axeRuleId]: string[] } with up to 5 element samples per rule.
 */
export function accessibilityIssues(elements) {
  const out = {};
  const add = (rule, el) => {
    out[rule] = out[rule] || [];
    if (out[rule].length < 5) out[rule].push(describe(el));
    else out[rule].count = (out[rule].count || 5) + 1;
  };
  const labelFor = new Set(elements.filter((e) => e.tag === "label" && e.attrs.for).map((e) => e.attrs.for));
  const ids = new Map();
  let mains = 0;
  for (const el of elements) {
    if (el.attrs.id) ids.set(el.attrs.id, (ids.get(el.attrs.id) || 0) + 1);
    if (el.tag === "main" || el.attrs.role === "main") mains++;
    if (el.attrs["aria-hidden"] === "true" || el.ancestors.includes("svg")) continue;
    const control = (el.tag === "input" && !LABELLED_TYPES.has((el.attrs.type || "text").toLowerCase())) || el.tag === "select" || el.tag === "textarea";
    if (control) {
      const labelled =
        el.ancestors.includes("label") || (el.attrs.id && labelFor.has(el.attrs.id)) || el.attrs["aria-label"]?.trim() || el.attrs["aria-labelledby"]?.trim() || el.attrs.title?.trim();
      if (!labelled) add("label", el);
      if (el.attrs.autocomplete !== undefined && !validAutocomplete(el.attrs.autocomplete)) add("autocomplete-valid", el);
    }
    if (el.tag === "a" && el.attrs.href !== undefined && !hasName(el)) add("link-name", el);
    if (el.tag === "button" && !hasName(el)) add("button-name", el);
  }
  if (mains !== 1) out["landmark-one-main"] = [mains === 0 ? "no <main> element" : `${mains} main landmarks`];
  const dup = [...ids.entries()].filter(([, n]) => n > 1).map(([id, n]) => `id="${id}" ×${n}`);
  if (dup.length) out["duplicate-id"] = dup.slice(0, 5);
  return out;
}
