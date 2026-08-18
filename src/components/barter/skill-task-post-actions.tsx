'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import type { BarterSkillTaskPostStatus, SkillTaskDirection } from '@/types'

type Action = 'pause' | 'resume' | 'close' | 'archive' | 'repost'

function availableActions(status: BarterSkillTaskPostStatus, direction: SkillTaskDirection): Action[] {
  const actions: Action[] = []
  if (direction === 'available') {
    if (status === 'active') actions.push('pause', 'archive')
    if (status === 'paused') actions.push('resume', 'archive')
  } else {
    if (status === 'active' || status === 'offers_received') actions.push('close')
    if (status === 'closed' || status === 'matched') actions.push('archive')
  }
  if (status === 'archived' || status === 'closed') actions.push('repost')
  return [...new Set(actions)]
}

export function SkillTaskPostActions({ postId, status, direction }: { postId: string; status: BarterSkillTaskPostStatus; direction: SkillTaskDirection }) {
  const router = useRouter()
  const t = useTranslations('merchant.skillTaskPosts')
  const [pending, setPending] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions = availableActions(status, direction)
  if (actions.length === 0) return null

  async function run(action: Action) {
    setPending(action)
    setError(null)
    try {
      const res = await fetch(`/api/barter/skill-task/${postId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('errors.actionFailed'))
        return
      }
      if (action === 'repost' && data?.post_id) {
        router.push(`/dashboard/barter/skill-task/${data.post_id}/edit`)
        return
      }
      router.refresh()
    } catch {
      setError(t('errors.actionFailedRetry'))
    } finally {
      setPending(null)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action}
            onClick={() => run(action)}
            disabled={pending !== null}
            className="px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors disabled:opacity-50"
          >
            {pending === action ? t('actions.working') : t(`actions.${action}`)}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}
