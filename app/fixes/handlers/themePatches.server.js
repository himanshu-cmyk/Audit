// Predefined, deterministic theme patches. Each one inserts a single, fixed
// Liquid snippet at one exactly-identified location, and refuses when the
// expected anchor is missing, ambiguous, or the fix is already present.
// Nothing here removes or rewrites existing theme code.

import crypto from "crypto";

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

const fail = (reason) => ({ ok: false, reason });

export const THEME_PATCHES = {
  theme_html_lang: {
    filename: "layout/theme.liquid",
    summary: 'Add lang="{{ request.locale.iso_code }}" to the <html> tag.',
    apply(content) {
      const tags = content.match(/<html\b[^>]*>/gi) || [];
      if (tags.length === 0) return fail("No <html> tag was found in layout/theme.liquid.");
      if (tags.length > 1) return fail("More than one <html> tag was found. Refusing an ambiguous edit.");
      if (/\slang\s*=/i.test(tags[0])) {
        return fail("The <html> tag already has a lang attribute. The audit may be out of date for this theme.");
      }
      const at = content.search(/<html\b/i) + "<html".length;
      return {
        ok: true,
        content: `${content.slice(0, at)} lang="{{ request.locale.iso_code }}"${content.slice(at)}`,
      };
    },
    check(content) {
      const tags = content.match(/<html\b[^>]*>/gi) || [];
      return tags.length === 1 && /\slang\s*=/i.test(tags[0]);
    },
  },

  theme_canonical_tag: {
    filename: "layout/theme.liquid",
    summary: 'Add <link rel="canonical" href="{{ canonical_url }}"> before </head>.',
    // Head-rendered files containing this make the fix a duplicate.
    marker: /canonical/i,
    markerLabel: "a canonical tag",
    apply(content) {
      if (/canonical/i.test(content)) {
        return fail("layout/theme.liquid already references a canonical URL. Refusing to add a duplicate.");
      }
      const heads = content.match(/<\/head\s*>/gi) || [];
      if (heads.length !== 1) {
        return fail(`Expected exactly one </head> in layout/theme.liquid, found ${heads.length}.`);
      }
      const at = content.search(/<\/head\s*>/i);
      const lineStart = content.lastIndexOf("\n", at - 1) + 1;
      const indent = /^\s*$/.test(content.slice(lineStart, at)) ? content.slice(lineStart, at) : "";
      const insert = `${indent ? "  " : ""}<link rel="canonical" href="{{ canonical_url }}">\n${indent}`;
      return { ok: true, content: `${content.slice(0, at)}${insert}${content.slice(at)}` };
    },
    check(content) {
      return /<link[^>]+rel=["']canonical["'][^>]*\{\{\s*canonical_url\s*\}\}/i.test(content);
    },
  },
};

// Theme files rendered inside <head> by a layout or snippet, used to check whether
// a tag is already produced somewhere other than layout/theme.liquid. References
// whose output cannot be inspected deterministically (dynamic names, section
// groups) are returned as `unsupported`.
export function headIncludes(content, { headOnly = true } = {}) {
  const region = headOnly ? (content.match(/<head\b[\s\S]*?<\/head\s*>/i)?.[0] ?? "") : content;
  const files = new Set();
  const unsupported = [];
  const re = /\{%-?\s*(render|include|section|sections)\s+([^\s%,]+)/g;
  let m;
  while ((m = re.exec(region))) {
    const [, tag, arg] = m;
    const name = arg.match(/^['"]([\w.-]+)['"]$/)?.[1];
    if (!name) unsupported.push(`${tag} ${arg}`);
    else if (tag === "render" || tag === "include") files.add(`snippets/${name}.liquid`);
    else if (tag === "section") files.add(`sections/${name}.liquid`);
    else unsupported.push(`sections '${name}'`);
  }
  return { files: [...files], unsupported };
}

// Minimal, deterministic line diff for a single contiguous change, with context.
export function lineDiff(before, after, context = 2) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - context);
  return {
    startLine: from + 1,
    before: a.slice(from, Math.min(a.length, endA + 1 + context)).map((l) => l.slice(0, 400)),
    after: b.slice(from, Math.min(b.length, endB + 1 + context)).map((l) => l.slice(0, 400)),
  };
}
