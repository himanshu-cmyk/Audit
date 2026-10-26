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

// The audit CLI's --json output: { meta, analysis, narrative }.
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
