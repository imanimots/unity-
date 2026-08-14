'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Clock, Circle, CalendarClock } from 'lucide-react'
import { MilestoneEvidencePanel } from './milestone-evidence-panel'
import type { BarterOfferItem, BarterMilestoneEvidence } from '@/types'

const inputClass =
  'w-full px-3 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20'

const STATUS_META: Record<string, { label: string; classes: string; icon: typeof Check }> = {
  pending: { label: 'Pending', classes: 'text-[#9B8B85]', icon: Circle },
  active: { label: 'Active', classes: 'text-[#8B1A1A]', icon: Clock },
  completed: { label: 'Completed', classes: 'text-green-600 dark:text-green-400', icon: Check },
}

interface ContributionMilestonesPanelProps {
  agreementId: string
  offerItem: BarterOfferItem
  currentUserId: string
  partyAId: string
  partyBId: string
  partyAName: string
  partyBName: string
  evidenceByMilestone: Record<string, BarterMilestoneEvidence[]>
  readOnly?: boolean
}

function ScheduleWidget({
  agreementId,
  milestoneId,
  scheduledAt,
  scheduledCity,
  scheduledProvince,
  confirmedBy,
  currentUserId,
  partyAId,
  partyBId,
  partyAName,
  partyBName,
  readOnly,
}: {
  agreementId: string
  milestoneId: string
  scheduledAt: string | null
  scheduledCity: string | null
  scheduledProvince: string | null
  confirmedBy: string[]
  currentUserId: string
  partyAId: string
  partyBId: string
  partyAName: string
  partyBName: string
  readOnly?: boolean
}) {
  const router = useRouter()
  const [proposing, setProposing] = useState(false)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [city, setCity] = useState('')
  const [province, setProvince] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasSchedule = !!scheduledAt
  const iHaveConfirmed = confirmedBy.includes(currentUserId)

  async function submitSchedule() {
    if (!date || !time || !city.trim() || !province.trim()) {
      setError('Date, time, city, and province are all required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/barter/${agreementId}/milestones/${milestoneId}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduled_at: new Date(`${date}T${time}`).toISOString(),
          scheduled_city: city.trim(),
          scheduled_province: province.trim(),
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not propose a schedule')
        return
      }
      setProposing(false)
      router.refresh()
    } catch {
      setError('Could not propose a schedule — please try again')
    } finally {
      setBusy(false)
    }
  }

  async function confirmSchedule() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/barter/${agreementId}/milestones/${milestoneId}/schedule/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not confirm the schedule')
        return
      }
      router.refresh()
    } catch {
      setError('Could not confirm the schedule — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg bg-[#FAF8F5] dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] p-2.5 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] flex items-center gap-1.5">
        <CalendarClock size={12} /> In-person schedule
      </p>
      {hasSchedule ? (
        <div className="text-xs text-[#1A0A0A] dark:text-[#F5F0ED] space-y-1">
          <p>
            {new Date(scheduledAt!).toLocaleString()} · {scheduledCity}, {scheduledProvince}
          </p>
          <div className="flex gap-3">
            <span className={confirmedBy.includes(partyAId) ? 'text-green-600 dark:text-green-400' : 'text-[#9B8B85]'}>
              {confirmedBy.includes(partyAId) ? '✓' : '—'} {partyAName}
            </span>
            <span className={confirmedBy.includes(partyBId) ? 'text-green-600 dark:text-green-400' : 'text-[#9B8B85]'}>
              {confirmedBy.includes(partyBId) ? '✓' : '—'} {partyBName}
            </span>
          </div>
          {!readOnly && !iHaveConfirmed && (
            <button onClick={confirmSchedule} disabled={busy} className="mt-1 px-3 py-1.5 rounded-lg bg-[#8B1A1A] text-white text-xs font-semibold hover:bg-[#7A1616] transition-colors disabled:opacity-50">
              {busy ? 'Confirming…' : 'Confirm this schedule'}
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs text-[#9B8B85]">No schedule proposed yet.</p>
      )}

      {!readOnly && !hasSchedule && (
        <>
          {proposing ? (
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputClass} />
              <input type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" className={inputClass} />
              <input type="text" value={province} onChange={(e) => setProvince(e.target.value)} placeholder="Province" className={inputClass} />
              <button onClick={submitSchedule} disabled={busy} className="col-span-2 px-3 py-1.5 rounded-lg bg-[#8B1A1A] text-white text-xs font-semibold hover:bg-[#7A1616] transition-colors disabled:opacity-50">
                {busy ? 'Proposing…' : 'Propose schedule'}
              </button>
            </div>
          ) : (
            <button onClick={() => setProposing(true)} className="px-3 py-1.5 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-xs font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
              Propose a date, time &amp; location
            </button>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

/** One skill/task contribution's milestone list in sequence order, with schedule + evidence controls for the currently active milestone. */
export function ContributionMilestonesPanel({
  agreementId,
  offerItem,
  currentUserId,
  partyAId,
  partyBId,
  partyAName,
  partyBName,
  evidenceByMilestone,
  readOnly,
}: ContributionMilestonesPanelProps) {
  const router = useRouter()
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const milestones = (offerItem.milestones ?? []).slice().sort((a, b) => a.sequence - b.sequence)
  const details = offerItem.contribution_details
  const isPerformer = offerItem.offered_by === currentUserId

  async function markComplete(milestoneId: string) {
    setCompleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/barter/${agreementId}/milestones/${milestoneId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not mark this milestone complete')
        return
      }
      router.refresh()
    } catch {
      setError('Could not mark this milestone complete — please try again')
    } finally {
      setCompleting(false)
    }
  }

  return (
    <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-4 space-y-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#8B1A1A]">{offerItem.kind === 'skill' ? 'Skill' : 'Task'}</p>
        <h3 className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{details?.title ?? 'Contribution'}</h3>
        {details?.description && <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">{details.description}</p>}
        <p className="text-xs text-[#9B8B85] mt-1">{offerItem.contribution_weight_percent}% of this side&apos;s contribution</p>
      </div>

      <div className="space-y-2">
        {milestones.map((m) => {
          const meta = STATUS_META[m.status]
          const Icon = meta.icon
          return (
            <div key={m.id} className="rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon size={14} className={meta.classes} />
                  <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] truncate">
                    {m.sequence}. {m.title}
                  </span>
                  <span className="text-xs text-[#9B8B85]">({m.weight_percent}%)</span>
                </div>
                <span className={`text-[10px] font-bold uppercase tracking-[0.06em] shrink-0 ${meta.classes}`}>{meta.label}</span>
              </div>
              {m.description && <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">{m.description}</p>}

              {m.status === 'active' && (
                <div className="space-y-2 pt-1">
                  {m.delivery_mode === 'in_person' && (
                    <ScheduleWidget
                      agreementId={agreementId}
                      milestoneId={m.id}
                      scheduledAt={m.scheduled_at}
                      scheduledCity={m.scheduled_city}
                      scheduledProvince={m.scheduled_province}
                      confirmedBy={m.schedule_confirmed_by}
                      currentUserId={currentUserId}
                      partyAId={partyAId}
                      partyBId={partyBId}
                      partyAName={partyAName}
                      partyBName={partyBName}
                      readOnly={readOnly}
                    />
                  )}
                  <MilestoneEvidencePanel
                    agreementId={agreementId}
                    milestoneId={m.id}
                    currentUserId={currentUserId}
                    evidence={evidenceByMilestone[m.id] ?? []}
                    canUpload={!readOnly}
                  />
                  {!readOnly && isPerformer && (
                    <button
                      onClick={() => markComplete(m.id)}
                      disabled={completing}
                      className="px-3 py-1.5 rounded-lg bg-[#8B1A1A] text-white text-xs font-semibold hover:bg-[#7A1616] transition-colors disabled:opacity-50"
                    >
                      {completing ? 'Marking…' : 'Mark complete'}
                    </button>
                  )}
                </div>
              )}

              {m.status === 'completed' && (evidenceByMilestone[m.id]?.length ?? 0) > 0 && (
                <MilestoneEvidencePanel agreementId={agreementId} milestoneId={m.id} currentUserId={currentUserId} evidence={evidenceByMilestone[m.id] ?? []} canUpload={false} />
              )}
            </div>
          )
        })}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
