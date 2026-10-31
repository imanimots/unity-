import Link from 'next/link'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getIntelligenceInsights, EVIDENCE_BASIS_LABEL, type IntelligenceInsight, type IntelligencePriority, type IntelligenceInsightType, type IntelligenceConfidence, type IntelligenceDataSufficiency, type IntelligenceScope, type IntelligenceSourceStatus } from '@/lib/admin/intelligence-service'
import { AdminPageHeader, StatCard, Pill, formatDateTime } from '@/components/admin/ui'

const PRIORITY_STYLES: Record<IntelligencePriority, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-[#F2EDE8] text-[#6B5B55]',
}

const TYPE_STYLES: Record<IntelligenceInsightType, string> = {
  risk: 'bg-red-100 text-red-700',
  opportunity: 'bg-green-100 text-green-700',
  watch: 'bg-amber-100 text-amber-700',
  informational: 'bg-blue-100 text-blue-700',
}

const CONFIDENCE_STYLES: Record<IntelligenceConfidence, string> = {
  high: 'bg-green-100 text-green-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-[#F2EDE8] text-[#6B5B55]',
}

const SUFFICIENCY_STYLES: Record<IntelligenceDataSufficiency, string> = {
  sufficient: 'bg-green-100 text-green-700',
  limited: 'bg-amber-100 text-amber-700',
  insufficient: 'bg-[#F2EDE8] text-[#6B5B55]',
}

const SCOPE_STYLES: Record<IntelligenceScope, string> = {
  'real-data': 'bg-[#8B1A1A] text-white',
  'operational-all-system': 'bg-[#6B5B55] text-white',
}

const SCOPE_LABEL: Record<IntelligenceScope, string> = {
  'real-data': 'Real Data',
  'operational-all-system': 'Operational (all-system)',
}

/**
 * E2: Source Health -- one row per Intelligence input source, independent
 * of whether it produced an insight this cycle. Only the already-safe
 * `IntelligenceSourceStatus` fields (human-readable label/status/scope/
 * rule ids) are rendered -- never a raw error, Postgres message, or
 * stack trace (the service layer never exposes those to begin with).
 * Healthy sources render in neutral styling; a degraded source is the
 * only state that gets an attention color, so a fully healthy cycle
 * never looks alarming.
 */
function SourceHealthSection({ sourceHealth }: { sourceHealth: IntelligenceSourceStatus[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Data sources / source health</p>
        {/* E2-F1: availability is diagnostic/current-state metadata ("could this cycle read this source"), never a 30-day evidence window -- no universal freshness claim is shown here. */}
        <p className="text-xs text-[#9B8B85]">Status at generation time</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sourceHealth.map((s) => {
          const degraded = s.status === 'degraded'
          return (
            <div
              key={s.source}
              className={`rounded-lg border p-3 ${degraded ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-[#2A1A05]' : 'border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010]'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{s.label}</p>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-[0.08em] whitespace-nowrap ${degraded ? 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-200' : 'bg-green-100 text-green-700'}`}>
                  {degraded ? 'Degraded' : 'Available'}
                </span>
              </div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-[#9B8B85] mt-1">{SCOPE_LABEL[s.scope]}</p>
              {degraded && s.usedBy.length > 0 && (
                <p className="text-xs text-amber-800 dark:text-amber-300 mt-2">
                  May be incomplete: <span className="font-mono">{s.usedBy.join(', ')}</span>
                </p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}


function InsightCard({ insight }: { insight: IntelligenceInsight }) {
  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill value={insight.priority} styles={PRIORITY_STYLES} />
          <Pill value={insight.type} styles={TYPE_STYLES} />
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">{insight.category.replace(/-/g, ' ')}</span>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-[0.08em] whitespace-nowrap ${SCOPE_STYLES[insight.scope]}`}>
          {SCOPE_LABEL[insight.scope]}
        </span>
      </div>

      <div>
        <h3 className="text-sm font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{insight.title}</h3>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">{insight.summary}</p>
      </div>

      <p className="text-xs text-[#9B8B85] italic">{insight.rationale}</p>

      {insight.evidence.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {insight.evidence.map((e) => (
            <div key={e.label} className="bg-[#FAF8F5] dark:bg-[#0F0808] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-1.5">
              <p className="text-[10px] uppercase tracking-[0.08em] text-[#9B8B85]">{e.label}</p>
              <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{e.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="bg-amber-50 dark:bg-[#2A1A05] border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
        <p className="text-xs text-amber-900 dark:text-amber-200"><span className="font-semibold">Recommendation: </span>{insight.recommendation}</p>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <div className="flex items-center gap-2">
          <Pill value={insight.confidence} styles={CONFIDENCE_STYLES} />
          <Pill value={insight.dataSufficiency} styles={SUFFICIENCY_STYLES} />
        </div>
        {insight.actionHref && (
          <Link href={insight.actionHref} className="text-xs font-medium uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline whitespace-nowrap">
            {insight.actionLabel ?? 'View'} →
          </Link>
        )}
      </div>

      {/* E2: expandable explainability -- rule id, trigger/threshold detail, limitations, and freshness. Purely informational, read-only; no mutation control anywhere in this element. */}
      <details className="pt-1 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] pt-2">
          Why did this appear?
        </summary>
        <div className="mt-2 space-y-2 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
          <p><span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Rule ID: </span><span className="font-mono">{insight.ruleId}</span></p>
          {insight.trigger && (
            <p>
              <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Trigger: </span>
              {insight.trigger.metric}
              {insight.trigger.operator && insight.trigger.observedValue !== undefined && (
                <span className="font-mono">
                  {' '}({insight.trigger.operator} {String(insight.trigger.observedValue)}
                  {insight.trigger.thresholdValue !== undefined ? `, threshold ${insight.trigger.thresholdValue}` : ''}
                  {insight.trigger.comparisonValue !== undefined ? `, prior ${insight.trigger.comparisonValue}` : ''})
                </span>
              )}
            </p>
          )}
          {insight.limitations.length > 0 && (
            <div>
              <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Limitations:</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {insight.limitations.map((l) => <li key={l}>{l}</li>)}
              </ul>
            </div>
          )}
          {/* E2-F1: "Generated" means when this Intelligence result was computed, never when the underlying source data was refreshed. "Evidence" names this rule's own honest basis (EVIDENCE_BASIS_LABEL, from RULE_REGISTRY) -- "Last 30 days" only for genuinely period-based rules; "Current snapshot" or "Structural diagnostic" otherwise, never a fabricated window. */}
          <p><span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Generated: </span>{formatDateTime(insight.freshness.generatedAt)} · <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Evidence: </span>{EVIDENCE_BASIS_LABEL[insight.freshness.evidenceBasis]}</p>
        </div>
      </details>
    </div>
  )
}

export default async function AdminIntelligencePage() {
  const requester = await requireAdmin()
  if (!requester) {
    return <div className="p-8 text-sm text-[#9B8B85]">You must be signed in as an administrator.</div>
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return <div className="p-8 text-sm text-[#9B8B85]">Intelligence storage is not configured.</div>
  }

  const result = await getIntelligenceInsights(admin)
  const dataQualityInsights = result.insights.filter((i) => i.category === 'data-quality')
  const otherInsights = result.insights.filter((i) => i.category !== 'data-quality')

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <AdminPageHeader eyebrow="AI R&D" title="AI R&D & Intelligence" badge="Recommendation only" />
        {/* E2-F1: only the generation timestamp is shown globally -- this page mixes period/snapshot/structural evidence, so a single universal "Evidence window" claim here would be false for whichever insights aren't period-based. Each insight's own "Why did this appear?" detail discloses its own accurate evidence basis. */}
        <p className="text-xs text-[#9B8B85]">Generated {formatDateTime(result.generatedAt)}</p>
      </div>

      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] max-w-3xl">
        Evidence-based marketplace intelligence and recommendations derived from Unity&apos;s verified analytics and operational signals.
        Every recommendation is advisory -- nothing here performs an action, changes a record, or contacts a user.
      </p>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Summary</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <StatCard label="Active insights" value={result.summary.totalInsights} />
          <StatCard label="High priority" value={result.summary.highPriority} />
          <StatCard label="Opportunities" value={result.summary.opportunities} />
          <StatCard label="Risks / watch" value={result.summary.risksAndWatch} />
          <StatCard label="Data limitations" value={result.summary.dataQualityLimitations} />
        </div>
      </section>

      <SourceHealthSection sourceHealth={result.sourceHealth} />

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Prioritized insights</p>
        {otherInsights.length === 0 ? (
          <p className="text-sm text-[#9B8B85]">No business insights currently clear the data-sufficiency bar -- see Data Quality below for why.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {otherInsights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Data quality</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {dataQualityInsights.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
        </div>
      </section>

      <section className="bg-[#FAF8F5] dark:bg-[#0F0808] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Methodology &amp; safety</p>
        <ul className="text-xs text-[#6B5B55] dark:text-[#9B8B85] space-y-1 list-disc pl-4">
          <li>Recommendations are advisory only -- no Intelligence insight performs, triggers, or links to an automated admin action.</li>
          <li>Every insight is generated deterministically from Unity&apos;s own already-verified Admin analytics and operational data -- no external AI provider, model, or data source is used in this phase.</li>
          <li>&quot;Real Data&quot; insights use only confirmed-real records (profiles.data_classification = &apos;real&apos;, or an entity&apos;s own equivalent positive-proof rule) -- test and unresolved/unknown records are excluded, never guessed at.</li>
          <li>&quot;Operational (all-system)&quot; insights (Support, KYC review, ownership/moderation, Exceptions) intentionally include every record regardless of classification, because staff must action all of them -- these are workload signals, never confirmed-real business metrics, and are never mixed numerically with Real Data insights.</li>
          <li>Sparse, unresolved, or unknown-classification data reduces confidence and is reported as such rather than presented as a confident conclusion.</li>
          <li>No figure here represents settled cash or completed live payment/payout/escrow settlement -- those provider integrations remain mock, manual, or stub in the relevant paths.</li>
        </ul>
      </section>
    </div>
  )
}
