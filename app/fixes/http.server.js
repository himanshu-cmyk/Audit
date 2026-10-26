import { FixError } from "./graphql.server";
import { ImportError } from "./importer.server";

// Converts known, merchant-safe errors into action data. Anything else
// (including thrown Responses used for re-authentication) propagates.
export function toActionError(err) {
  if (err instanceof FixError || err instanceof ImportError) {
    const details = Array.isArray(err.details) ? err.details.filter((d) => typeof d === "string") : [];
    return { ok: false, error: err.message, details };
  }
  throw err;
}

// Reads a JSON-encoded form field with a size cap. Returns null when invalid.
export function readJsonField(form, name, maxLength = 200000) {
  const raw = form.get(name);
  if (typeof raw !== "string" || raw.length > maxLength) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
