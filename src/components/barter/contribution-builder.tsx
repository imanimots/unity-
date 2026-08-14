'use client'

import { Plus, Trash2 } from 'lucide-react'
import type { BarterSkillTaskPublicPost, SkillTaskKind, SkillTaskDeliveryMode } from '@/types'

const inputClass =
  'w-full px-3 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20'
const labelClass = 'text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block'

export interface ContributionMilestoneInput {
  title: string
  description?: string
  sequence: number
  weight_percent: number
}

export interface ContributionInput {
  kind: SkillTaskKind
  skill_task_post_id?: string
  title?: string
  description?: string
  delivery_mode?: SkillTaskDeliveryMode
  province?: string
  city?: string
  contribution_weight_percent: number
  milestones: ContributionMilestoneInput[]
}

export function newContribution(): ContributionInput {
  return {
    kind: 'skill',
    contribution_weight_percent: 100,
    milestones: [{ title: '', sequence: 1, weight_percent: 100 }],
  }
}

function milestoneSum(milestones: ContributionMilestoneInput[]): number {
  return milestones.reduce((sum, m) => sum + (Number(m.weight_percent) || 0), 0)
}

export function contributionWeightSum(contributions: ContributionInput[]): number {
  return contributions.reduce((sum, c) => sum + (Number(c.contribution_weight_percent) || 0), 0)
}

/** True only when every contribution has >=1 milestone summing to exactly 100, and (if >1 contribution) the party's own weights sum to exactly 100. */
export function contributionsValid(contributions: ContributionInput[]): boolean {
  if (contributions.length === 0) return true
  const weightOk = Math.abs(contributionWeightSum(contributions) - 100) < 0.01
  const milestonesOk = contributions.every((c) => c.milestones.length > 0 && Math.abs(milestoneSum(c.milestones) - 100) < 0.01 && (c.skill_task_post_id || c.title?.trim()))
  return weightOk && milestonesOk
}

interface ContributionCardProps {
  contribution: ContributionInput
  availablePosts: BarterSkillTaskPublicPost[]
  onChange: (next: ContributionInput) => void
  onRemove: () => void
}

function ContributionCard({ contribution, availablePosts, onChange, onRemove }: ContributionCardProps) {
  const matchingPosts = availablePosts.filter((p) => p.kind === contribution.kind)
  const isCustom = !contribution.skill_task_post_id

  function addMilestone() {
    onChange({ ...contribution, milestones: [...contribution.milestones, { title: '', sequence: contribution.milestones.length + 1, weight_percent: 0 }] })
  }
  function removeMilestone(i: number) {
    onChange({ ...contribution, milestones: contribution.milestones.filter((_, idx) => idx !== i).map((m, idx) => ({ ...m, sequence: idx + 1 })) })
  }
  function updateMilestone(i: number, patch: Partial<ContributionMilestoneInput>) {
    onChange({ ...contribution, milestones: contribution.milestones.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) })
  }

  const mSum = milestoneSum(contribution.milestones)

  return (
    <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex gap-2">
          {(['skill', 'task'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onChange({ ...contribution, kind: k, skill_task_post_id: undefined })}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                contribution.kind === k ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]' : 'border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED]'
              }`}
            >
              {k === 'skill' ? 'Skill' : 'Task'}
            </button>
          ))}
        </div>
        <button type="button" onClick={onRemove} className="p-1.5 text-[#9B8B85] hover:text-red-600">
          <Trash2 size={14} />
        </button>
      </div>

      <div>
        <label className={labelClass}>Source</label>
        <select
          value={contribution.skill_task_post_id ?? ''}
          onChange={(e) => onChange({ ...contribution, skill_task_post_id: e.target.value || undefined, title: e.target.value ? undefined : contribution.title })}
          className={inputClass}
        >
          <option value="">Custom / private contribution</option>
          {matchingPosts.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
      </div>

      {isCustom && (
        <>
          <div>
            <label className={labelClass}>Title</label>
            <input type="text" value={contribution.title ?? ''} onChange={(e) => onChange({ ...contribution, title: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Description (optional)</label>
            <textarea value={contribution.description ?? ''} onChange={(e) => onChange({ ...contribution, description: e.target.value })} rows={2} className={`${inputClass} resize-none`} />
          </div>
        </>
      )}

      <div>
        <label className={labelClass}>Contribution weight (% of this party&apos;s side)</label>
        <input
          type="number"
          min={0}
          max={100}
          value={contribution.contribution_weight_percent || ''}
          onChange={(e) => onChange({ ...contribution, contribution_weight_percent: Number(e.target.value) || 0 })}
          className={inputClass}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className={labelClass}>Milestones</label>
          <button type="button" onClick={addMilestone} className="flex items-center gap-1 text-xs font-medium text-[#8B1A1A] hover:underline">
            <Plus size={12} /> Add
          </button>
        </div>
        {contribution.milestones.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_70px_32px] gap-2">
            <input type="text" value={m.title} onChange={(e) => updateMilestone(i, { title: e.target.value })} placeholder={`Milestone ${m.sequence}`} className={inputClass} />
            <input type="number" min={0} max={100} value={m.weight_percent || ''} onChange={(e) => updateMilestone(i, { weight_percent: Number(e.target.value) || 0 })} placeholder="%" className={inputClass} />
            {contribution.milestones.length > 1 && (
              <button type="button" onClick={() => removeMilestone(i)} className="p-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#9B8B85] hover:text-red-600">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
        <p className={`text-xs font-medium ${Math.abs(mSum - 100) < 0.01 ? 'text-[#9B8B85]' : 'text-red-600'}`}>Milestone weights: {mSum}% (must equal 100%)</p>
      </div>
    </div>
  )
}

interface ContributionListEditorProps {
  title: string
  contributions: ContributionInput[]
  availablePosts: BarterSkillTaskPublicPost[]
  onChange: (next: ContributionInput[]) => void
}

export function ContributionListEditor({ title, contributions, availablePosts, onChange }: ContributionListEditorProps) {
  const sum = contributionWeightSum(contributions)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{title}</label>
        <button
          type="button"
          onClick={() => onChange([...contributions, newContribution()])}
          className="flex items-center gap-1 text-xs font-medium text-[#8B1A1A] hover:underline"
        >
          <Plus size={13} /> Add Skill/Task contribution
        </button>
      </div>
      {contributions.map((c, i) => (
        <ContributionCard
          key={i}
          contribution={c}
          availablePosts={availablePosts}
          onChange={(next) => onChange(contributions.map((existing, idx) => (idx === i ? next : existing)))}
          onRemove={() => onChange(contributions.filter((_, idx) => idx !== i))}
        />
      ))}
      {contributions.length > 1 && (
        <p className={`text-xs font-medium ${Math.abs(sum - 100) < 0.01 ? 'text-[#9B8B85]' : 'text-red-600'}`}>Contribution weights total {sum}% (must equal 100%)</p>
      )}
    </div>
  )
}
