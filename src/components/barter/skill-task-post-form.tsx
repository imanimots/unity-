'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { CATEGORIES } from '@/types'
import type { BarterSkillTaskPost, BarterSkillTaskPostMilestoneTemplate, SkillTaskKind, SkillTaskDirection, SkillTaskDeliveryMode } from '@/types'

const inputClass =
  'w-full px-3.5 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20'
const labelClass = 'text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block'

interface MilestoneTemplateRow {
  title: string
  description: string
  sequence: number
  weight_percent: number
}

function templatesFromInitial(templates?: BarterSkillTaskPostMilestoneTemplate[]): MilestoneTemplateRow[] {
  if (!templates || templates.length === 0) return []
  return templates
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((t) => ({ title: t.title, description: t.description ?? '', sequence: t.sequence, weight_percent: t.weight_percent }))
}

interface SkillTaskPostFormProps {
  initialPost?: BarterSkillTaskPost
  initialMilestoneTemplates?: BarterSkillTaskPostMilestoneTemplate[]
  /** Resolved server-side from initialPost.category_id (categories.slug) since the post row itself only stores the FK, not the slug the save-draft RPC expects. */
  initialCategorySlug?: string
}

/**
 * Covers both create (/dashboard/barter/skill-task/new) and edit
 * (.../[id]/edit). kind/direction/category/wants-flags/milestone
 * templates are only editable while the post has never been published
 * (save_barter_skill_task_post_draft() is the write path) --
 * update_barter_skill_task_post() (used once first_published_at is
 * set) structurally has no parameter for any of those, so this form
 * locks them the same way once that's true, mirroring the RPC layer
 * exactly rather than inventing a looser client-side rule.
 */
export function SkillTaskPostForm({ initialPost, initialMilestoneTemplates, initialCategorySlug }: SkillTaskPostFormProps) {
  const router = useRouter()
  const locked = !!initialPost?.first_published_at

  const [postId, setPostId] = useState<string | undefined>(initialPost?.id)
  const [kind, setKind] = useState<SkillTaskKind>(initialPost?.kind ?? 'skill')
  const [direction, setDirection] = useState<SkillTaskDirection>(initialPost?.direction ?? 'available')
  const [title, setTitle] = useState(initialPost?.title ?? '')
  const [description, setDescription] = useState(initialPost?.description ?? '')
  const [categorySlug, setCategorySlug] = useState<string>(initialCategorySlug ?? '')
  const [deliveryMode, setDeliveryMode] = useState<SkillTaskDeliveryMode>(initialPost?.delivery_mode ?? 'either')
  const [province, setProvince] = useState(initialPost?.province ?? '')
  const [city, setCity] = useState(initialPost?.city ?? '')
  const [exclusions, setExclusions] = useState(initialPost?.exclusions ?? '')
  const [materialsArrangement, setMaterialsArrangement] = useState(initialPost?.materials_arrangement ?? '')
  const [evidenceExpectations, setEvidenceExpectations] = useState(initialPost?.evidence_expectations ?? '')
  const [desiredExchangeNotes, setDesiredExchangeNotes] = useState(initialPost?.desired_exchange_notes ?? '')
  const [wantsItem, setWantsItem] = useState(initialPost?.wants_item ?? false)
  const [wantsSkill, setWantsSkill] = useState(initialPost?.wants_skill ?? false)
  const [wantsTask, setWantsTask] = useState(initialPost?.wants_task ?? false)
  const [wantsCashAdjustment, setWantsCashAdjustment] = useState(initialPost?.wants_cash_adjustment ?? false)
  const [availabilityNotes, setAvailabilityNotes] = useState(initialPost?.availability_notes ?? '')
  const [preferredStartDate, setPreferredStartDate] = useState(initialPost?.preferred_start_date ?? '')
  const [preferredStartTime, setPreferredStartTime] = useState(initialPost?.preferred_start_time ?? '')
  const [deadline, setDeadline] = useState(initialPost?.deadline ?? '')
  const [expectedDurationNotes, setExpectedDurationNotes] = useState(initialPost?.expected_duration_notes ?? '')
  const [milestones, setMilestones] = useState<MilestoneTemplateRow[]>(templatesFromInitial(initialMilestoneTemplates))

  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const milestoneWeightSum = milestones.reduce((sum, m) => sum + (Number(m.weight_percent) || 0), 0)
  const milestonesValid = milestones.length === 0 || Math.abs(milestoneWeightSum - 100) < 0.01

  function addMilestone() {
    setMilestones((prev) => [...prev, { title: '', description: '', sequence: prev.length + 1, weight_percent: 0 }])
  }

  function removeMilestone(index: number) {
    setMilestones((prev) => prev.filter((_, i) => i !== index).map((m, i) => ({ ...m, sequence: i + 1 })))
  }

  function updateMilestone(index: number, patch: Partial<MilestoneTemplateRow>) {
    setMilestones((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)))
  }

  function draftBody() {
    return {
      post_id: postId,
      kind,
      direction,
      title: title || undefined,
      description: description || undefined,
      category_slug: categorySlug || undefined,
      delivery_mode: deliveryMode,
      province: province || undefined,
      city: city || undefined,
      exclusions: exclusions || undefined,
      materials_arrangement: materialsArrangement || undefined,
      evidence_expectations: evidenceExpectations || undefined,
      desired_exchange_notes: desiredExchangeNotes || undefined,
      wants_item: wantsItem,
      wants_skill: wantsSkill,
      wants_task: wantsTask,
      wants_cash_adjustment: wantsCashAdjustment,
      availability_notes: availabilityNotes || undefined,
      preferred_start_date: preferredStartDate || undefined,
      preferred_start_time: preferredStartTime || undefined,
      deadline: deadline || undefined,
      expected_duration_notes: expectedDurationNotes || undefined,
      milestone_templates: milestones.length
        ? milestones.map((m) => ({ title: m.title, description: m.description || undefined, sequence: m.sequence, weight_percent: Number(m.weight_percent) }))
        : undefined,
      idempotency_key: crypto.randomUUID(),
    }
  }

  function updateBody() {
    return {
      title: title || undefined,
      description: description || undefined,
      delivery_mode: deliveryMode,
      province: province || undefined,
      city: city || undefined,
      exclusions: exclusions || undefined,
      materials_arrangement: materialsArrangement || undefined,
      evidence_expectations: evidenceExpectations || undefined,
      desired_exchange_notes: desiredExchangeNotes || undefined,
      availability_notes: availabilityNotes || undefined,
      preferred_start_date: preferredStartDate || undefined,
      preferred_start_time: preferredStartTime || undefined,
      deadline: deadline || undefined,
      expected_duration_notes: expectedDurationNotes || undefined,
      idempotency_key: crypto.randomUUID(),
    }
  }

  async function handleSave(): Promise<string | null> {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      if (locked && postId) {
        const res = await fetch(`/api/barter/skill-task/${postId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateBody()),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error ?? 'Could not save your changes')
          return null
        }
        setSaved(true)
        router.refresh()
        return postId
      }

      if (!title.trim() || !description.trim()) {
        setError('Title and description are required.')
        return null
      }

      const res = await fetch('/api/barter/skill-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody()),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not save your draft')
        return null
      }
      setPostId(data.post_id)
      setSaved(true)
      return data.post_id as string
    } catch {
      setError('Could not save — please try again')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function handlePublish() {
    if (!milestonesValid) {
      setError('Milestone weights must add up to exactly 100% before publishing.')
      return
    }
    setPublishing(true)
    setError(null)
    try {
      const idToUse = postId ?? (await handleSave())
      if (!idToUse) return

      const res = await fetch(`/api/barter/skill-task/${idToUse}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not publish this post')
        return
      }
      router.push('/dashboard/barter/skill-task')
    } catch {
      setError('Could not publish — please try again')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Kind</label>
          <div className="flex gap-2">
            {(['skill', 'task'] as const).map((k) => (
              <button
                key={k}
                type="button"
                disabled={locked}
                onClick={() => setKind(k)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  kind === k ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED]'
                }`}
              >
                {k === 'skill' ? 'Skill' : 'Task'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={labelClass}>Direction</label>
          <div className="flex gap-2">
            {(['available', 'looking_for'] as const).map((d) => (
              <button
                key={d}
                type="button"
                disabled={locked}
                onClick={() => setDirection(d)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  direction === d ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED]'
                }`}
              >
                {d === 'available' ? 'Available' : 'Looking For'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {locked && <p className="text-xs text-[#9B8B85]">Kind and direction can no longer change — this post has already been published.</p>}

      <div>
        <label className={labelClass}>Title</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekend furniture assembly help" className={inputClass} />
      </div>

      <div>
        <label className={labelClass}>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`${inputClass} resize-none`} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Category</label>
          <select value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} disabled={locked} className={`${inputClass} disabled:opacity-50`}>
            <option value="">Select…</option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Delivery mode</label>
          <select value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value as SkillTaskDeliveryMode)} className={inputClass}>
            <option value="remote">Remote</option>
            <option value="in_person">In person</option>
            <option value="either">Either</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Province</label>
          <input type="text" value={province} onChange={(e) => setProvince(e.target.value)} placeholder="e.g. Gauteng" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>City</label>
          <input type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Johannesburg" className={inputClass} />
        </div>
      </div>
      <p className="text-xs text-[#9B8B85] -mt-3">City/province only — an exact address is never collected here.</p>

      <div>
        <label className={labelClass}>Exclusions (optional)</label>
        <textarea value={exclusions} onChange={(e) => setExclusions(e.target.value)} rows={2} placeholder="What's not included…" className={`${inputClass} resize-none`} />
      </div>
      <div>
        <label className={labelClass}>Materials arrangement (optional)</label>
        <textarea value={materialsArrangement} onChange={(e) => setMaterialsArrangement(e.target.value)} rows={2} className={`${inputClass} resize-none`} />
      </div>
      <div>
        <label className={labelClass}>Evidence expectations (optional)</label>
        <textarea value={evidenceExpectations} onChange={(e) => setEvidenceExpectations(e.target.value)} rows={2} className={`${inputClass} resize-none`} />
      </div>
      <div>
        <label className={labelClass}>Desired exchange notes (optional)</label>
        <textarea value={desiredExchangeNotes} onChange={(e) => setDesiredExchangeNotes(e.target.value)} rows={2} placeholder="What you'd like in return…" className={`${inputClass} resize-none`} />
      </div>

      <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-3.5 space-y-2">
        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">What would satisfy this? (matching signals)</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" checked={wantsItem} disabled={locked} onChange={(e) => setWantsItem(e.target.checked)} className="accent-[#8B1A1A]" /> An item
          </label>
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" checked={wantsSkill} disabled={locked} onChange={(e) => setWantsSkill(e.target.checked)} className="accent-[#8B1A1A]" /> A skill
          </label>
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" checked={wantsTask} disabled={locked} onChange={(e) => setWantsTask(e.target.checked)} className="accent-[#8B1A1A]" /> A task
          </label>
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" checked={wantsCashAdjustment} disabled={locked} onChange={(e) => setWantsCashAdjustment(e.target.checked)} className="accent-[#8B1A1A]" /> Cash top-up
          </label>
        </div>
        {locked && <p className="text-xs text-[#9B8B85]">These signals can no longer change after publishing.</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Preferred start date (optional)</label>
          <input type="date" value={preferredStartDate} onChange={(e) => setPreferredStartDate(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Preferred start time (optional)</label>
          <input type="time" value={preferredStartTime} onChange={(e) => setPreferredStartTime(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Deadline (optional)</label>
          <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Expected duration notes (optional)</label>
          <input type="text" value={expectedDurationNotes} onChange={(e) => setExpectedDurationNotes(e.target.value)} placeholder="e.g. About 3 hours" className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass}>Availability notes (optional)</label>
        <textarea value={availabilityNotes} onChange={(e) => setAvailabilityNotes(e.target.value)} rows={2} className={`${inputClass} resize-none`} />
      </div>

      <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Milestone preview (optional)</p>
            <p className="text-xs text-[#9B8B85]">Discovery-time preview only — not binding. The real milestones are set when an offer is made.</p>
          </div>
          {!locked && (
            <button type="button" onClick={addMilestone} className="flex items-center gap-1 text-xs font-medium text-[#8B1A1A] hover:underline shrink-0">
              <Plus size={13} /> Add
            </button>
          )}
        </div>

        {milestones.map((m, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_80px_36px] gap-2 items-start">
            <input
              type="text"
              value={m.title}
              disabled={locked}
              onChange={(e) => updateMilestone(i, { title: e.target.value })}
              placeholder={`Milestone ${m.sequence} title`}
              className={`${inputClass} disabled:opacity-50`}
            />
            <input
              type="text"
              value={m.description}
              disabled={locked}
              onChange={(e) => updateMilestone(i, { description: e.target.value })}
              placeholder="Description (optional)"
              className={`${inputClass} disabled:opacity-50`}
            />
            <input
              type="number"
              min={0}
              max={100}
              value={m.weight_percent || ''}
              disabled={locked}
              onChange={(e) => updateMilestone(i, { weight_percent: Number(e.target.value) || 0 })}
              placeholder="%"
              className={`${inputClass} disabled:opacity-50`}
            />
            {!locked && (
              <button type="button" onClick={() => removeMilestone(i)} className="p-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#9B8B85] hover:text-red-600">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}

        {milestones.length > 0 && (
          <p className={`text-xs font-medium ${milestonesValid ? 'text-[#6B5B55] dark:text-[#9B8B85]' : 'text-red-600'}`}>
            Weights total {milestoneWeightSum}% — must equal exactly 100% before publishing.
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && !error && <p className="text-sm text-green-600 dark:text-green-400">Saved.</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || publishing}
          className="px-5 py-2.5 rounded-xl border border-[#8B1A1A] text-[#8B1A1A] font-semibold text-sm hover:bg-[#8B1A1A]/5 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : locked ? 'Save changes' : 'Save draft'}
        </button>
        {!locked && (
          <button
            type="button"
            onClick={handlePublish}
            disabled={saving || publishing}
            className="px-5 py-2.5 rounded-xl bg-[#8B1A1A] text-white font-semibold text-sm hover:bg-[#7A1616] transition-colors disabled:opacity-50"
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        )}
      </div>
    </div>
  )
}
