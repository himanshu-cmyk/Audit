/* eslint-env node */
// Builders for audit files in the exact shapes the First Sight audit tool emits.

export function finding(id, category, urls, extra = {}) {
  return {
    id,
    category,
    severity: "medium",
    title: `Finding ${id}`,
    detail: `Detail for ${id}.`,
    recommendation: `Recommendation for ${id}.`,
    evidence: null,
    url: urls[0] ?? null,
    affectedUrls: urls,
    pageCount: urls.length,
    instances: urls.length,
    fix: {
      fix_type: "set_meta_admin",
      risk: "low",
      autoApplicable: false,
      explanation: "Explanation.",
      generated_fix: "Template steps.",
      estimated_impact: "Quick win.",
      generatedBy: "template",
    },
    ...extra,
  };
}

// The Node audit tool's current schemaVersion 1 report, with summaries that are
// consistent with the findings unless overridden.
export function reportV1({ host = "www.example-store.com", findings, overall = 72, grade = "C", ...over }) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) if (f && f.severity in counts) counts[f.severity]++;
  const pagesCrawled = [`https://${host}/`, `https://${host}/products/blue-shirt`];
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-20T10:05:00.000Z",
    meta: { url: `https://${host}/`, host, crawledAt: "2026-10-20T10:00:00.000Z", device: "desktop", narrativeGeneratedBy: "template" },
    summary: {
      overall,
      grade,
      counts: { ...counts },
      totalFindings: findings.length,
      autoApplicableFixes: findings.filter((f) => f?.fix?.autoApplicable === true).length,
      pagesCrawled: [...pagesCrawled],
    },
    overall,
    grade,
    findings,
    categoryScores: { seo: { key: "seo", label: "SEO", score: 70, grade: "C", count: findings.length } },
    counts,
    pagesCrawled,
    cwv: {
      fcp: 812.4,
      lcp: { startTime: 1490, renderTime: 1520.6, size: 120000, url: `https://${host}/cdn/hero.jpg`, id: "", tagName: "IMG", className: "hero", isLazyLoaded: true, hasFetchPriorityHigh: false, snippet: "<img class=hero>" },
      cls: 0.1234,
      clsEntries: [{ value: 0.1234, sources: [{ tagName: "DIV", className: "banner", id: "" }] }],
      longTasks: [{ startTime: 900, duration: 120, blockingDuration: 70, name: "self", attribution: "script" }],
      tbt: 70,
    },
    cdpMetrics: { taskDuration: 1500.2, scriptDuration: 640.7, layoutDuration: 80.1, recalcStyleDuration: 45.5, jsHeapUsedSize: 10240 },
    narrative: {
      executiveSummary: "The store loads reasonably but several SEO fields are missing.",
      prioritizedActions: [{ title: "Add meta descriptions", why: "Search snippets", severity: "medium" }],
      categoryNarratives: { seo: "SEO text." },
      generatedBy: "template",
    },
    ...over,
  };
}

// The audit CLI's older --json output: { meta, analysis, narrative } (legacy).
export function auditJson({ host = "www.example-store.com", findings, overall = 72, grade = "C" }) {
  return JSON.stringify({
    meta: { url: `https://${host}/`, host, crawledAt: "2026-10-20T10:00:00.000Z" },
    analysis: { overall, grade, findings, categoryScores: {}, counts: {} },
    narrative: { generatedBy: "rule-based" },
  });
}

// approved-fixes.json as produced by the HTML report's download button.
export function approvedFixesJson({ host = "www.example-store.com", fixes }) {
  return JSON.stringify({
    meta: { store: host, target: `https://${host}/`, generatedAt: "2026-10-20T11:00:00.000Z" },
    fixes: fixes.map((f) => ({
      id: f.id,
      title: f.title,
      category: f.category,
      severity: f.severity,
      fix_type: f.fix.fix_type,
      risk: f.fix.risk,
      autoApplicable: f.fix.autoApplicable,
      url: f.url,
      affectedUrls: f.affectedUrls,
      generated_fix: f.fix.generated_fix,
    })),
  });
}
