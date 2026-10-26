// Adapter for the First Sight Store Audit outputs. Two real formats are supported:
//
//  1. approved-fixes.json, downloaded from the HTML report:
//     { meta: { store, target, generatedAt }, fixes: [ { id, title, category, severity,
//       fix_type, risk, autoApplicable, url, affectedUrls, generated_fix } ] }
//
//  2. The audit CLI's --json output:
//     { meta: { url, host, crawledAt }, analysis: { overall, grade, findings: [ { id,
//       category, severity, title, detail, recommendation, evidence, url, affectedUrls,
//       fix: { fix_type, risk, autoApplicable, explanation, generated_fix, ... } } ] } }
//
// Everything in the file is untrusted. Values are type-checked, length-capped and
// stripped of control characters. The audit's own "autoApplicable" and
// "generated_fix" are kept only as informational text: what the app may execute is
// decided by the server-side fix registry, never by the file.

import {
  AUDIT_CATEGORIES,
  MAX_IMPORT_BYTES,
  RISKS,
  SEVERITIES,
  displayCategoryFor,
} from "./constants";
import { cleanLine, cleanText, normalizeHost, safeHttpUrl } from "./text";

export { MAX_IMPORT_BYTES };
export const MAX_FINDINGS = 1000;
const MAX_URLS_PER_FINDING = 200;
const FINDING_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

export class ImportError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ImportError";
    this.details = details;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseDate(v) {
  if (typeof v !== "string" || v.length > 64) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseScore(v) {
  return Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
}

export function detectFormat(data) {
  if (!isPlainObject(data)) return null;
  if (isPlainObject(data.analysis) && Array.isArray(data.analysis.findings)) {
    return "audit-json";
  }
  if (Array.isArray(data.fixes)) return "approved-fixes";
  return null;
}

function normalizeFinding(raw, index, format, errors, warnings) {
  const where = `Finding #${index + 1}`;
  if (!isPlainObject(raw)) {
    errors.push(`${where}: expected an object.`);
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!FINDING_ID_RE.test(id)) {
    errors.push(`${where}: missing or invalid "id".`);
    return null;
  }
  const label = `${where} (${id})`;
  const title = cleanLine(raw.title, 300);
  if (!title) errors.push(`${label}: missing "title".`);
  if (!AUDIT_CATEGORIES.includes(raw.category)) {
    errors.push(`${label}: unsupported category "${cleanLine(String(raw.category), 40)}".`);
  }
  if (!SEVERITIES.includes(raw.severity)) {
    errors.push(`${label}: unsupported severity "${cleanLine(String(raw.severity), 40)}".`);
  }
  if (!title || !AUDIT_CATEGORIES.includes(raw.category) || !SEVERITIES.includes(raw.severity)) {
    return null;
  }

  // The fix block lives at the top level in approved-fixes.json and under .fix
  // in the CLI JSON.
  const fixSrc = format === "audit-json" ? raw.fix : raw;
  let audit = null;
  if (isPlainObject(fixSrc)) {
    const risk = RISKS.includes(fixSrc.risk) ? fixSrc.risk : null;
    if (fixSrc.risk !== undefined && !risk) {
      warnings.push(`${label}: ignored unknown risk value.`);
    }
    audit = {
      fixType: cleanLine(fixSrc.fix_type, 80),
      risk,
      autoApplicable: fixSrc.autoApplicable === true,
      generatedFix: cleanText(fixSrc.generated_fix, 10000),
      explanation: cleanText(fixSrc.explanation, 2000),
      estimatedImpact: cleanText(fixSrc.estimated_impact, 1000),
      generatedBy: cleanLine(fixSrc.generatedBy, 120),
    };
  }

  const url = raw.url == null ? null : safeHttpUrl(raw.url);
  const urlListed = Array.isArray(raw.affectedUrls) && raw.affectedUrls.includes(raw.url);
  if (raw.url != null && !url && !urlListed) {
    warnings.push(`${label}: dropped a non-http(s) page URL.`);
  }
  const affected = [];
  if (raw.affectedUrls !== undefined && !Array.isArray(raw.affectedUrls)) {
    errors.push(`${label}: "affectedUrls" must be an array.`);
    return null;
  }
  let dropped = 0;
  for (const u of (raw.affectedUrls || []).slice(0, MAX_URLS_PER_FINDING)) {
    const s = safeHttpUrl(u);
    if (s) {
      if (!affected.includes(s)) affected.push(s);
    } else dropped++;
  }
  if (dropped) warnings.push(`${label}: dropped ${dropped} non-http(s) affected URL(s).`);
  if (url && !affected.includes(url)) affected.unshift(url);

  return {
    key: id,
    auditId: id,
    title,
    category: raw.category,
    displayCategory: displayCategoryFor(id, raw.category),
    severity: raw.severity,
    description: cleanText(raw.detail, 5000),
    recommendation: cleanText(raw.recommendation, 3000),
    evidence: cleanText(raw.evidence, 10000),
    url,
    affectedUrls: affected,
    audit,
  };
}

// Parses and validates an uploaded audit file. Throws ImportError with a
// merchant-readable message (and up to 20 details) on any problem.
export function parseAuditFile(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new ImportError("The file is empty.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) {
    throw new ImportError("The file is larger than the 5 MB limit.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError("The file is not valid JSON.");
  }
  const format = detectFormat(data);
  if (!format) {
    throw new ImportError(
      "Unsupported format. Upload the approved-fixes.json downloaded from the audit report, or the file written by the audit tool's --json option.",
    );
  }

  const meta = isPlainObject(data.meta) ? data.meta : {};
  const rawFindings = format === "audit-json" ? data.analysis.findings : data.fixes;
  if (rawFindings.length === 0) {
    throw new ImportError("The file contains no findings.");
  }
  if (rawFindings.length > MAX_FINDINGS) {
    throw new ImportError(`The file has more than ${MAX_FINDINGS} findings.`);
  }

  const errors = [];
  const warnings = [];
  const findings = [];
  const seen = new Set();
  rawFindings.forEach((raw, i) => {
    const f = normalizeFinding(raw, i, format, errors, warnings);
    if (!f) return;
    if (seen.has(f.key)) {
      errors.push(`Finding #${i + 1} (${f.key}): duplicate id.`);
      return;
    }
    seen.add(f.key);
    findings.push(f);
  });
  if (errors.length) {
    throw new ImportError(
      `The file failed validation (${errors.length} problem${errors.length === 1 ? "" : "s"}).`,
      errors.slice(0, 20),
    );
  }

  if (format === "approved-fixes") {
    warnings.unshift(
      "Selections in approved-fixes.json are not treated as approval. Every change must be reviewed and approved in this app before anything is applied.",
    );
  }

  const auditedUrl =
    safeHttpUrl(format === "audit-json" ? meta.url : meta.target) || null;
  const hostField = format === "audit-json" ? meta.host : meta.store;
  const auditedHost =
    normalizeHost(typeof hostField === "string" ? hostField : "") ||
    (auditedUrl ? normalizeHost(auditedUrl) : null);
  if (!auditedHost) {
    warnings.push(
      "The file does not name a public store domain, so it cannot be matched to this store. You can review it, but store changes are disabled.",
    );
  }

  const analysis = format === "audit-json" ? data.analysis : {};
  return {
    sourceFormat: format,
    auditedUrl,
    auditedHost,
    auditDate: parseDate(format === "audit-json" ? meta.crawledAt : meta.generatedAt),
    overallScore: parseScore(analysis.overall),
    grade: typeof analysis.grade === "string" && /^[A-F]$/.test(analysis.grade) ? analysis.grade : null,
    findings,
    warnings: warnings.slice(0, 50),
  };
}
