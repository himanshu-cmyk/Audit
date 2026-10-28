// Adapter for the Node audit tool's reports. Formats accepted:
//
//  1. schemaVersion 1 JSON (current): { schemaVersion: 1, generatedAt, meta: { url,
//     host, crawledAt, device, narrativeGeneratedBy }, summary, overall, grade,
//     findings: [ { id, category, severity, title, detail, recommendation, evidence,
//     url, affectedUrls, pageCount, instances, fix } ], categoryScores, counts,
//     pagesCrawled, cwv, cdpMetrics, narrative }. Validated strictly.
//
//  2. Legacy, explicitly labelled and validated separately:
//     - "audit-json": the older --json output { meta, analysis: { findings, ... } }
//     - "approved-fixes": the HTML report's unversioned { meta, fixes } download.
//       Its selections are suggestions only, never approval.
//
// Everything in the file is untrusted. Values are type-checked, length-capped and
// stripped of control characters. The audit's own "autoApplicable", "risk" and
// "generated_fix" are kept only as informational text: what the app may execute is
// decided by the server-side fix registry, never by the file.

import {
  AUDIT_CATEGORIES,
  MAX_IMPORT_BYTES,
  RISKS,
  SEVERITIES,
  displayCategoryFor,
} from "./constants";
import {
  CONTRACT_VERSION,
  STRUCTURE_LIMITS,
  StructureError,
  SUPPORTED_SCHEMA_VERSIONS,
  assertSafeStructure,
  canonicalJson,
  isKnownSourceId,
  readHomepageMetrics,
  sha256,
  stableFindingId,
  summaryConsistency,
} from "./reportContract.server";
import { cleanLine, cleanText, normalizeHost, safeHttpUrl } from "./text";

export { MAX_IMPORT_BYTES };
export const MAX_FINDINGS = 1000;
const MAX_URLS_PER_FINDING = 200;
const FINDING_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

export const IMPORT_LIMITS = {
  maxBytes: MAX_IMPORT_BYTES,
  maxFindings: MAX_FINDINGS,
  maxUrlsPerFinding: MAX_URLS_PER_FINDING,
  ...STRUCTURE_LIMITS,
};

export const SOURCE_FORMATS = {
  V1: "node-report-v1",
  LEGACY_CLI: "audit-json",
  LEGACY_APPROVED: "approved-fixes",
  // Audit run inside this app (not an uploaded file).
  IN_APP: "in-app",
};

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
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null;
}

const parseGrade = (v) => (typeof v === "string" && /^[A-F][+-]?$/.test(v) ? v : null);

export function detectFormat(data) {
  if (!isPlainObject(data)) return null;
  if (Object.prototype.hasOwnProperty.call(data, "schemaVersion")) return SOURCE_FORMATS.V1;
  if (isPlainObject(data.analysis) && Array.isArray(data.analysis.findings)) return SOURCE_FORMATS.LEGACY_CLI;
  if (Array.isArray(data.fixes)) return SOURCE_FORMATS.LEGACY_APPROVED;
  return null;
}

const optString = (v) => v === undefined || v === null || typeof v === "string";
const count = (v) => Number.isInteger(v) && v >= 0;

// schemaVersion 1 field types. Returns a list of problems for one finding.
function strictFindingProblems(raw) {
  const p = [];
  if (typeof raw.title !== "string") p.push('"title" must be text');
  for (const k of ["detail", "recommendation"]) if (typeof raw[k] !== "string") p.push(`"${k}" must be text`);
  for (const k of ["evidence", "url"]) if (!optString(raw[k])) p.push(`"${k}" must be text or null`);
  if (!Array.isArray(raw.affectedUrls)) p.push('"affectedUrls" must be a list');
  else if (raw.affectedUrls.some((u) => typeof u !== "string")) p.push('"affectedUrls" must contain only text');
  for (const k of ["pageCount", "instances"]) if (!count(raw[k])) p.push(`"${k}" must be a whole number`);
  if (raw.fix !== null) {
    if (!isPlainObject(raw.fix)) p.push('"fix" must be an object or null');
    else {
      const f = raw.fix;
      if (typeof f.fix_type !== "string") p.push('"fix.fix_type" must be text');
      if (!RISKS.includes(f.risk)) p.push('"fix.risk" must be low, medium or high');
      if (typeof f.autoApplicable !== "boolean") p.push('"fix.autoApplicable" must be true or false');
      for (const k of ["explanation", "generated_fix", "estimated_impact", "generatedBy"]) {
        if (!optString(f[k])) p.push(`"fix.${k}" must be text`);
      }
    }
  }
  return p;
}

function normalizeFinding(raw, index, format, errors, warnings) {
  const where = `Finding #${index + 1}`;
  if (!isPlainObject(raw)) {
    errors.push(`${where}: expected an object.`);
    return null;
  }
  // Missing ids are never derived from prose: the finding is rejected.
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!FINDING_ID_RE.test(id)) {
    errors.push(`${where}: missing or invalid "id".`);
    return null;
  }
  const label = `${where} (${id})`;
  const strict = format === SOURCE_FORMATS.V1;
  if (strict) {
    const problems = strictFindingProblems(raw);
    if (problems.length) {
      errors.push(`${label}: ${problems.join("; ")}.`);
      return null;
    }
  }
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
  const fixSrc = format === SOURCE_FORMATS.LEGACY_APPROVED ? raw : raw.fix;
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
  if ((raw.affectedUrls || []).length > MAX_URLS_PER_FINDING) {
    warnings.push(`${label}: only the first ${MAX_URLS_PER_FINDING} affected URLs were kept.`);
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

  const evidence = cleanText(raw.evidence, 10000);
  return {
    key: id,
    findingId: stableFindingId(id, affected, evidence),
    sourceId: id,
    auditId: id,
    known: isKnownSourceId(id),
    title,
    category: raw.category,
    displayCategory: displayCategoryFor(id, raw.category),
    severity: raw.severity,
    description: cleanText(raw.detail, 5000),
    recommendation: cleanText(raw.recommendation, 3000),
    evidence,
    url,
    affectedUrls: affected,
    pageCount: count(raw.pageCount) ? raw.pageCount : null,
    instances: count(raw.instances) ? raw.instances : null,
    audit,
  };
}

// The source aggregates findings by id, so a repeated id is either an exact
// copy (dropped) or a conflict (kept once, flagged and never executable).
function dedupe(normalized, warnings) {
  const byKey = new Map();
  const out = [];
  for (const { f, index } of normalized) {
    const sig = canonicalJson(f);
    const prev = byKey.get(f.key);
    if (!prev) {
      byKey.set(f.key, { f, sig });
      out.push(f);
    } else if (prev.sig === sig) {
      warnings.push(`Finding #${index + 1} (${f.key}): exact duplicate removed.`);
    } else {
      prev.f.conflict = true;
      prev.f.conflictNote = `The file contains conflicting entries for "${f.key}" (for example different severity, pages or evidence). It is shown for reference only and cannot be fixed from this import.`;
      warnings.push(`Finding #${index + 1} (${f.key}): conflicts with an earlier entry with the same id; marked unsupported.`);
    }
  }
  return out;
}

function readMetaV1(data, warnings, errors) {
  const meta = isPlainObject(data.meta) ? data.meta : null;
  if (!meta) {
    errors.push('"meta" must be an object.');
    return {};
  }
  for (const k of ["url", "host", "crawledAt", "narrativeGeneratedBy"]) {
    if (!optString(meta[k])) errors.push(`"meta.${k}" must be text.`);
  }
  if (meta.device !== undefined && !["desktop", "mobile"].includes(meta.device)) {
    errors.push('"meta.device" must be "desktop" or "mobile".');
  }
  if (data.generatedAt !== undefined && typeof data.generatedAt !== "string") errors.push('"generatedAt" must be text.');
  const sourceUrl = safeHttpUrl(meta.url) || null;
  const urlHost = sourceUrl ? normalizeHost(sourceUrl) : null;
  const metaHost = normalizeHost(typeof meta.host === "string" ? meta.host : "");
  let auditedHost = metaHost || urlHost;
  if (metaHost && urlHost && metaHost !== urlHost) {
    warnings.push(`meta.host (${metaHost}) and meta.url (${urlHost}) disagree, so the report cannot be matched to a store. Store changes are disabled for this import.`);
    auditedHost = null;
  }
  const generatedAt = parseDate(data.generatedAt);
  const crawledAt = parseDate(meta.crawledAt);
  if (data.generatedAt != null && !generatedAt) warnings.push('"generatedAt" is not a valid date and was ignored.');
  if (meta.crawledAt != null && !crawledAt) warnings.push('"meta.crawledAt" is not a valid date and was ignored.');
  return {
    sourceUrl,
    auditedHost,
    generatedAt,
    crawledAt,
    device: meta.device ?? null,
    narrativeGeneratedBy: cleanLine(meta.narrativeGeneratedBy, 120),
  };
}

function readNarrative(n) {
  if (!isPlainObject(n)) return null;
  return {
    executiveSummary: cleanText(n.executiveSummary, 4000),
    prioritizedActions: Array.isArray(n.prioritizedActions)
      ? n.prioritizedActions
          .filter(isPlainObject)
          .slice(0, 10)
          .map((a) => ({
            title: cleanLine(a.title, 200),
            why: cleanText(a.why, 600),
            severity: SEVERITIES.includes(a.severity) ? a.severity : null,
          }))
      : [],
    generatedBy: cleanLine(n.generatedBy, 120),
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
  try {
    assertSafeStructure(data);
  } catch (err) {
    if (err instanceof StructureError) throw new ImportError(err.message);
    throw err;
  }
  const format = detectFormat(data);
  if (!format) {
    throw new ImportError(
      "Unsupported format. Upload the JSON report written by the audit tool (schemaVersion 1), or a legacy --json output or approved-fixes.json.",
    );
  }
  if (format === SOURCE_FORMATS.V1 && !SUPPORTED_SCHEMA_VERSIONS.includes(data.schemaVersion)) {
    throw new ImportError(
      `Unsupported report schemaVersion ${JSON.stringify(data.schemaVersion)}. This app supports schemaVersion ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }

  const rawFindings =
    format === SOURCE_FORMATS.V1 ? data.findings : format === SOURCE_FORMATS.LEGACY_CLI ? data.analysis.findings : data.fixes;
  if (!Array.isArray(rawFindings)) throw new ImportError('The report has no "findings" list.');
  if (rawFindings.length === 0) {
    throw new ImportError("The file contains no findings.");
  }
  if (rawFindings.length > MAX_FINDINGS) {
    throw new ImportError(`The file has more than ${MAX_FINDINGS} findings.`);
  }

  const errors = [];
  const warnings = [];
  const normalized = [];
  rawFindings.forEach((raw, index) => {
    const f = normalizeFinding(raw, index, format, errors, warnings);
    if (f) normalized.push({ f, index });
  });

  let source;
  let metrics = null;
  let summaryNotes = [];
  if (format === SOURCE_FORMATS.V1) {
    source = readMetaV1(data, warnings, errors);
    const m = readHomepageMetrics(data);
    errors.push(...m.errors);
    metrics = m.metrics;
    for (const k of ["pagesCrawled"]) {
      if (data[k] !== undefined && (!Array.isArray(data[k]) || data[k].some((u) => typeof u !== "string"))) {
        errors.push(`"${k}" must be a list of URLs.`);
      }
    }
    summaryNotes = summaryConsistency(data, rawFindings);
  } else {
    const meta = isPlainObject(data.meta) ? data.meta : {};
    const sourceUrl = safeHttpUrl(format === SOURCE_FORMATS.LEGACY_CLI ? meta.url : meta.target) || null;
    const hostField = format === SOURCE_FORMATS.LEGACY_CLI ? meta.host : meta.store;
    source = {
      sourceUrl,
      auditedHost:
        normalizeHost(typeof hostField === "string" ? hostField : "") || (sourceUrl ? normalizeHost(sourceUrl) : null),
      generatedAt: format === SOURCE_FORMATS.LEGACY_APPROVED ? parseDate(meta.generatedAt) : null,
      crawledAt: format === SOURCE_FORMATS.LEGACY_CLI ? parseDate(meta.crawledAt) : null,
      device: null,
      narrativeGeneratedBy: null,
    };
  }

  if (errors.length) {
    throw new ImportError(
      `The file failed validation (${errors.length} problem${errors.length === 1 ? "" : "s"}).`,
      errors.slice(0, 20),
    );
  }

  const findings = dedupe(normalized, warnings);

  if (format === SOURCE_FORMATS.LEGACY_APPROVED) {
    warnings.unshift(
      "Legacy approved-fixes.json: its selections are not treated as approval. Every change must be reviewed and approved in this app before anything is applied.",
    );
  } else if (format === SOURCE_FORMATS.LEGACY_CLI) {
    warnings.unshift("Legacy report format (no schemaVersion). It was validated with the legacy rules.");
  }
  if (!source.auditedHost) {
    warnings.push(
      "The file does not name a public store domain, so it cannot be matched to this store. You can review it, but store changes are disabled.",
    );
  }
  for (const n of summaryNotes) warnings.push(`Summary check: ${n}`);

  const scoreSrc = format === SOURCE_FORMATS.V1 ? data : format === SOURCE_FORMATS.LEGACY_CLI ? data.analysis : {};
  const pages = format === SOURCE_FORMATS.V1 ? data.pagesCrawled : scoreSrc.pagesCrawled;
  const unsupported = findings
    .filter((f) => f.conflict || !f.known)
    .map((f) => ({
      key: f.key,
      findingId: f.findingId,
      reason: f.conflict ? "Conflicting duplicate entries in the file." : "Unknown issue id: not produced by the supported audit tool version.",
    }));

  return {
    sourceFormat: format,
    legacy: format !== SOURCE_FORMATS.V1,
    auditedUrl: source.sourceUrl,
    auditedHost: source.auditedHost,
    auditDate: source.crawledAt || source.generatedAt,
    overallScore: parseScore(scoreSrc.overall),
    grade: parseGrade(scoreSrc.grade),
    findings,
    warnings: warnings.slice(0, 50),
    contract: {
      contractVersion: CONTRACT_VERSION,
      sourceSchemaVersion: format === SOURCE_FORMATS.V1 ? data.schemaVersion : null,
      rawSha256: sha256(text),
      contentDigest: sha256(canonicalJson(data)),
      sourceUrl: source.sourceUrl,
      generatedAt: source.generatedAt,
      crawledAt: source.crawledAt,
      device: source.device,
      narrativeGeneratedBy: source.narrativeGeneratedBy,
      pagesCrawled: Array.isArray(pages) ? pages.filter((u) => typeof u === "string").slice(0, 50).map((u) => cleanLine(u, 500)) : [],
      metrics,
      narrative: format === SOURCE_FORMATS.LEGACY_APPROVED ? null : readNarrative(data.narrative),
      summaryNotes,
      unsupported,
    },
  };
}
