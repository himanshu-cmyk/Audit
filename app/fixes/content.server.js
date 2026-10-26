// Validation of merchant-approved text values, and deterministic suggestions that
// only rephrase or shorten data the resource already has. Suggestions never invent
// features, materials or claims; when there is nothing to base one on, the
// suggestion is left empty and the merchant must write it.

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

export const FIELD_RULES = {
  seoTitle: { label: "SEO title", max: 70, idealMin: 30, idealMax: 60, singleLine: true },
  seoDescription: { label: "SEO description", max: 320, idealMin: 70, idealMax: 160, singleLine: true },
  altText: { label: "Alt text", max: 512, idealMin: 5, idealMax: 125, singleLine: true },
};

export function validateTextValue(value, rules, { previous } = {}) {
  const errors = [];
  const warnings = [];
  if (typeof value !== "string") {
    return { ok: false, value: null, errors: [`${rules.label} is required.`], warnings };
  }
  if (CONTROL_RE.test(value)) errors.push(`${rules.label} contains invalid control characters.`);
  let v = value.trim();
  if (rules.singleLine) v = v.replace(/\s+/g, " ");
  if (!v) errors.push(`${rules.label} cannot be empty.`);
  if (v.length > rules.max) errors.push(`${rules.label} must be ${rules.max} characters or fewer (currently ${v.length}).`);
  if (/[<>]/.test(v)) errors.push(`${rules.label} cannot contain HTML (< or >).`);
  if (/\{\{|\{%/.test(v)) errors.push(`${rules.label} cannot contain Liquid code.`);
  if (previous != null && v === String(previous).trim()) {
    errors.push(`${rules.label} is unchanged from the current value.`);
  }
  if (v && v.length < rules.idealMin) warnings.push(`${rules.label} is shorter than the recommended ${rules.idealMin} characters.`);
  if (v.length > rules.idealMax && v.length <= rules.max) {
    warnings.push(`${rules.label} is longer than ${rules.idealMax} characters and may be truncated in search results.`);
  }
  const counts = {};
  for (const w of v.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []) counts[w] = (counts[w] || 0) + 1;
  const stuffed = Object.entries(counts).filter(([, n]) => n > 3).map(([w]) => w);
  if (stuffed.length) warnings.push(`Possible keyword stuffing: "${stuffed.join('", "')}" repeated many times.`);
  return { ok: errors.length === 0, value: v, errors, warnings };
}

function collapse(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function cutAtWord(s, max) {
  if (s.length <= max) return s;
  const slice = s.slice(0, max + 1);
  const at = slice.lastIndexOf(" ");
  return (at > max * 0.6 ? slice.slice(0, at) : s.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
}

export function suggestSeoTitle({ resourceTitle, currentSeoTitle, shopName }) {
  const base = collapse(currentSeoTitle) || collapse(resourceTitle);
  if (!base) return { value: "", note: "Nothing to base a suggestion on. Write a title for this item." };
  if (base.length > 60) {
    return {
      value: cutAtWord(base, 60),
      note: "Shortened at a word boundary to fit in search results. Check it still reads well.",
    };
  }
  const shop = collapse(shopName);
  if (base.length < 30 && shop && !base.toLowerCase().includes(shop.toLowerCase()) && base.length + shop.length + 3 <= 60) {
    return { value: `${base} | ${shop}`, note: "Added your store name to make the title more descriptive." };
  }
  if (!collapse(currentSeoTitle)) {
    return {
      value: base,
      note: "No SEO title is set, so Shopify uses the item's title. This sets it explicitly. Your theme may add the store name to the page title, so keep it short enough to leave room.",
    };
  }
  return {
    value: base,
    note: "The current value is already within the recommended length. The page title the audit saw may include text added by your theme (for example the store name), so edit only if needed.",
  };
}

export function suggestSeoDescription({ currentSeoDescription, plainDescription }) {
  const current = collapse(currentSeoDescription);
  const body = collapse(plainDescription);
  let source = current;
  if (!source || (source.length < 50 && body.length > source.length)) source = body;
  if (source.length < 20) {
    return {
      value: "",
      note: "There is no existing description text to base a suggestion on. Write a description that accurately describes this item.",
    };
  }
  if (source.length <= 160) {
    return { value: source, note: "Based on the item's existing description text." };
  }
  const window = source.slice(0, 160);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentenceEnd >= 70) {
    return { value: window.slice(0, sentenceEnd + 1), note: "First sentences of the item's existing description." };
  }
  return { value: `${cutAtWord(source, 157)}…`, note: "Shortened from the item's existing description at a word boundary." };
}

export function suggestAltText({ productTitle, imageCountNeedingAlt }) {
  const title = collapse(productTitle);
  if (!title) return { value: "", note: "Describe what this image shows." };
  return {
    value: cutAtWord(title, 125),
    note:
      imageCountNeedingAlt > 1
        ? "Starts from the product title. Several images need alt text, so describe what this specific image shows (angle, colour, detail)."
        : "Starts from the product title. Adjust it to describe what the image actually shows.",
  };
}
