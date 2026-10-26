// Text helpers for untrusted input (imported audit JSON, merchant input,
// Shopify data echoed back). React escapes everything we render, and nothing
// here is ever interpreted as HTML, Liquid or code.

// C0 controls (except tab/newline/carriage return), DEL, and bidi overrides
// that can be used to disguise text.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

export function cleanText(value, max) {
  if (typeof value !== "string") return null;
  let s = value.replace(UNSAFE_CHARS, "").replace(/\r\n?/g, "\n");
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

export function cleanLine(value, max) {
  const s = cleanText(value, max * 2);
  if (s === null) return null;
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function safeHttpUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// Lower-cases, strips port / trailing dot / leading "www.". Returns null for
// anything that is not a plausible public hostname.
export function normalizeHost(value) {
  if (typeof value !== "string") return null;
  let h = value.trim().toLowerCase();
  if (h.includes("://")) {
    try {
      h = new URL(h).hostname;
    } catch {
      return null;
    }
  }
  h = h.replace(/:\d+$/, "").replace(/\.$/, "");
  if (h.startsWith("www.")) h = h.slice(4);
  return HOST_RE.test(h) ? h : null;
}

export function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
