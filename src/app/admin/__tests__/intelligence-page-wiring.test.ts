import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free structural guard -- same convention as the migration-source
// tests elsewhere in this codebase. No jsdom/component-render
// infrastructure exists in this repo (vitest runs in the `node`
// environment only), so Admin Server Component pages are verified by
// source inspection rather than a full render -- this proves the one
// property that matters here: the homepage summary card and
// /admin/intelligence consume the EXACT SAME service function, never a
// second, parallel implementation of the recommendation logic.
const REPO_ROOT = join(__dirname, '../../../..')

describe('Admin homepage Intelligence card wiring (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  const homepage = readFileSync(join(REPO_ROOT, 'src/app/admin/page.tsx'), 'utf-8')
  const intelligencePage = readFileSync(join(REPO_ROOT, 'src/app/admin/intelligence/page.tsx'), 'utf-8')

  it('1. both the homepage and /admin/intelligence import getIntelligenceInsights from the same service module -- no duplicated recommendation logic', () => {
    expect(homepage).toMatch(/import\s*\{[^}]*\bgetIntelligenceInsights\b[^}]*\}\s*from\s*'@\/lib\/admin\/intelligence-service'/)
    expect(intelligencePage).toMatch(/getIntelligenceInsights[^}]*\}\s*from\s*'@\/lib\/admin\/intelligence-service'/)
  })

  it('2. the homepage card reads only from the shared summary object (realData/operational/dataQualityLimitations), never recomputing or filtering the insight list itself', () => {
    expect(homepage).toMatch(/intelligence\.summary\.realData\.highPriority/)
    expect(homepage).toMatch(/intelligence\.summary\.realData\.opportunities/)
    expect(homepage).toMatch(/intelligence\.summary\.operational\.highPriority/)
    expect(homepage).toMatch(/intelligence\.summary\.dataQualityLimitations/)
    // The homepage never maps/filters the raw insights array -- it must not duplicate the page's own rendering of individual insight cards.
    expect(homepage).not.toMatch(/intelligence\.insights\.(map|filter)/)
  })

  it('2b. the homepage card visibly distinguishes Real Data from Operational (all-system) counts, rather than one scope-blind total', () => {
    expect(homepage).toMatch(/Real Data/)
    expect(homepage).toMatch(/Operational \(all-system\)/)
  })

  it('3. the homepage card links to /admin/intelligence rather than rendering full insight cards inline', () => {
    expect(homepage).toMatch(/href="\/admin\/intelligence"/)
  })

  it('4. no Intelligence insight recommendation text or UI label on either page names a mutating admin action (ban/suspend/approve/reject/refund/release payout/etc.)', () => {
    const forbidden = />(Approve|Reject|Suspend|Ban|Refund|Pay|Release|Resolve|Change Price|Change Plan|Contact User|Run Campaign)</
    expect(homepage).not.toMatch(forbidden)
    expect(intelligencePage).not.toMatch(forbidden)
  })

  it('5. the Intelligence page carries a visible "recommendation only" style badge', () => {
    expect(intelligencePage).toMatch(/badge="Recommendation only"/i)
  })
})

describe('Admin Intelligence page E2 explainability/diagnostics wiring (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  const homepage = readFileSync(join(REPO_ROOT, 'src/app/admin/page.tsx'), 'utf-8')
  const intelligencePage = readFileSync(join(REPO_ROOT, 'src/app/admin/intelligence/page.tsx'), 'utf-8')

  it('6. the Intelligence page renders a Source Health section driven by the service\'s own sourceHealth field, not a re-derived or hardcoded source list', () => {
    expect(intelligencePage).toMatch(/SourceHealthSection/)
    expect(intelligencePage).toMatch(/sourceHealth=\{result\.sourceHealth\}/)
    expect(intelligencePage).toMatch(/source health/i)
  })

  it('7. the Source Health section distinguishes available from degraded sources without alarming styling on a healthy source', () => {
    expect(intelligencePage).toMatch(/Available/)
    expect(intelligencePage).toMatch(/Degraded/)
    // Only the degraded branch gets the attention color; "degraded ?" is the sole conditional driving that style.
    expect(intelligencePage).toMatch(/degraded\s*\?\s*'border-amber-300/)
  })

  it('8. each insight card exposes rule ID, trigger, limitations, and freshness -- the E2 explainability fields -- behind a non-mutating expandable detail', () => {
    expect(intelligencePage).toMatch(/insight\.ruleId/)
    expect(intelligencePage).toMatch(/insight\.trigger/)
    expect(intelligencePage).toMatch(/insight\.limitations/)
    expect(intelligencePage).toMatch(/insight\.freshness/)
    expect(intelligencePage).toMatch(/<details/)
  })

  it('9. the explainability detail never introduces a mutation control (no button/form, no onClick/onSubmit handler)', () => {
    expect(intelligencePage).not.toMatch(/<button/i)
    expect(intelligencePage).not.toMatch(/<form/i)
    expect(intelligencePage).not.toMatch(/onClick=|onSubmit=/)
  })

  it('10. the zero-state ("no business insights clear the bar") and the data-quality section both still render unconditionally -- the E2 additions sit alongside them, not in place of them', () => {
    expect(intelligencePage).toMatch(/No business insights currently clear the data-sufficiency bar/)
    expect(intelligencePage).toMatch(/dataQualityInsights\.map/)
  })

  it('11. the homepage degraded-source indicator, when present, is derived from the service\'s own sourceHealth field and only rendered when something is actually degraded', () => {
    expect(homepage).toMatch(/intelligence\.sourceHealth\.filter/)
    expect(homepage).toMatch(/degradedSourceCount > 0/)
  })

  it('12. no new mutation action label was introduced by the E2 additions on either page', () => {
    const forbidden = />(Approve|Reject|Suspend|Ban|Refund|Pay|Release|Resolve|Change Price|Change Plan|Contact User|Run Campaign|Dismiss|Acknowledge|Mark Reviewed)</
    expect(homepage).not.toMatch(forbidden)
    expect(intelligencePage).not.toMatch(forbidden)
  })
})

describe('Admin Intelligence page E2-F1 freshness-semantics wiring (category: ADMIN-CONTROL-CENTRE-BATCH-E2-F1)', () => {
  const intelligencePage = readFileSync(join(REPO_ROOT, 'src/app/admin/intelligence/page.tsx'), 'utf-8')

  it('13. the page imports EVIDENCE_BASIS_LABEL from the service module as the single source of truth for freshness wording, rather than hardcoding "Last 30 days" itself', () => {
    expect(intelligencePage).toMatch(/import\s*\{[^}]*\bEVIDENCE_BASIS_LABEL\b[^}]*\}\s*from\s*'@\/lib\/admin\/intelligence-service'/)
    expect(intelligencePage).not.toMatch(/'Last 30 days'/)
  })

  it('14. each insight card renders its own evidence-basis label via EVIDENCE_BASIS_LABEL[insight.freshness.evidenceBasis], never a hardcoded universal window', () => {
    expect(intelligencePage).toMatch(/EVIDENCE_BASIS_LABEL\[insight\.freshness\.evidenceBasis\]/)
  })

  it('15. the page-level header shows only the generation timestamp, not a blanket "Evidence window: Last 30 days" claim that would misrepresent snapshot/structural insights on the same page', () => {
    expect(intelligencePage).not.toMatch(/Evidence window:\s*\{/)
  })

  it('16. the Source Health section treats availability as current-state diagnostic metadata, not a 30-day evidence window', () => {
    expect(intelligencePage).toMatch(/Status at generation time/)
  })
})

describe('Admin Intelligence page E3 human evaluation ledger wiring (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  const homepage = readFileSync(join(REPO_ROOT, 'src/app/admin/page.tsx'), 'utf-8')
  const intelligencePage = readFileSync(join(REPO_ROOT, 'src/app/admin/intelligence/page.tsx'), 'utf-8')
  const evaluationControls = readFileSync(join(REPO_ROOT, 'src/app/admin/intelligence/IntelligenceEvaluationControls.tsx'), 'utf-8')

  it('17. the evaluation controls component is imported and rendered only on the Intelligence page, never the Admin Overview homepage', () => {
    expect(intelligencePage).toMatch(/import\s*\{\s*IntelligenceEvaluationControls\s*\}\s*from\s*'\.\/IntelligenceEvaluationControls'/)
    expect(intelligencePage).toMatch(/<IntelligenceEvaluationControls/)
    expect(homepage).not.toMatch(/IntelligenceEvaluationControls/)
  })

  it('18. each insight card passes its own fingerprint/fingerprintVersion/ruleId and the batched-read current evaluation -- never a hardcoded default', () => {
    expect(intelligencePage).toMatch(/fingerprint=\{insight\.fingerprint\}/)
    expect(intelligencePage).toMatch(/fingerprintVersion=\{insight\.fingerprintVersion\}/)
    expect(intelligencePage).toMatch(/ruleId=\{insight\.ruleId\}/)
    expect(intelligencePage).toMatch(/currentEvaluation=\{evaluations\.get\(insight\.fingerprint\) \?\? null\}/)
  })

  it('19. the evaluation read is ONE batched query (getEvaluationsForFingerprints), never one query per insight -- no per-insight evaluation fetch call exists', () => {
    expect(intelligencePage).toMatch(/getEvaluationsForFingerprints\(admin, requester\.userId, fingerprints\)/)
    expect(intelligencePage).not.toMatch(/otherInsights\.map[\s\S]{0,80}getEvaluationsForFingerprints/)
  })

  it('20. the evaluation read is wrapped so a failure cannot break Intelligence rendering', () => {
    expect(intelligencePage).toMatch(/getEvaluationsForFingerprints\([^)]*\)\.catch\(/)
  })

  it('21. the control wording explicitly frames this as rating the Intelligence finding, not acting on the underlying user/transaction', () => {
    expect(evaluationControls).toMatch(/Rate this Intelligence finding/i)
    expect(evaluationControls).not.toMatch(/>(Approve|Reject|Suspend|Ban|Refund|Pay|Release|Resolve|Change Price|Change Plan|Contact User|Run Campaign)</)
  })

  it('22. there is no default evaluation -- the initial state comes only from the currentEvaluation prop (which the page derives from the real batched read), never a hardcoded string literal', () => {
    expect(evaluationControls).toMatch(/useState<string \| null>\(initialEvaluation\)/)
  })

  it('23. submission happens only via an explicit click handler -- no auto-submit on mount/hover/view (no useEffect, no onMouseEnter)', () => {
    expect(evaluationControls).toMatch(/onClick=\{\(\)\s*=>\s*submit\(/)
    expect(evaluationControls).not.toMatch(/useEffect/)
    expect(evaluationControls).not.toMatch(/onMouseEnter/)
  })

  it('24. "incorrect" and "not_useful" require a confirmation before the request is sent', () => {
    expect(evaluationControls).toMatch(/value: 'not_useful'[^}]*confirm:/)
    expect(evaluationControls).toMatch(/value: 'incorrect'[^}]*confirm:/)
    expect(evaluationControls).toMatch(/window\.confirm\(option\.confirm\)/)
  })

  it('25. the current evaluation is visibly distinguished from the other options (a distinct "isCurrent" style/marker), not just silently selected', () => {
    expect(evaluationControls).toMatch(/isCurrent/)
  })

  it('26. a write failure is shown as a small contained message, never thrown/unhandled -- the component stays usable', () => {
    expect(evaluationControls).toMatch(/catch\s*\{/)
    expect(evaluationControls).toMatch(/setError\(/)
  })

  it('27. a Human Evaluation summary section exists on the Intelligence page and is NOT present on the Admin Overview homepage', () => {
    expect(intelligencePage).toMatch(/EvaluationSummarySection/)
    expect(intelligencePage).toMatch(/Human evaluation summary/i)
    expect(homepage).not.toMatch(/EvaluationSummarySection|Human evaluation summary/i)
  })

  it('28. the evaluation summary is explicitly labeled as not a business metric', () => {
    expect(intelligencePage).toMatch(/not a business metric/i)
  })

  it('29. the rule-quality view, if present, shows counts only -- no percentage field and no automatic "bad rule" judgment language', () => {
    expect(intelligencePage).toMatch(/RuleQualitySection/)
    expect(intelligencePage).not.toMatch(/%/)
    expect(intelligencePage).not.toMatch(/\bbad rule\b|\bdisable(d)? rule\b/i)
  })

  it('30. no evaluation-related control anywhere introduces a marketplace enforcement action label', () => {
    const forbidden = />(Approve|Reject|Suspend|Ban|Refund|Pay|Release|Resolve|Change Price|Change Plan|Contact User|Run Campaign|Open Dispute|Suspend User|Flag Account)</
    expect(intelligencePage).not.toMatch(forbidden)
    expect(evaluationControls).not.toMatch(forbidden)
  })

  it('31. Recommendation-only safety messaging, Source Health, and the explainability detail all remain intact alongside the new evaluation section', () => {
    expect(intelligencePage).toMatch(/badge="Recommendation only"/i)
    expect(intelligencePage).toMatch(/SourceHealthSection/)
    expect(intelligencePage).toMatch(/Why did this appear\?/)
  })
})
