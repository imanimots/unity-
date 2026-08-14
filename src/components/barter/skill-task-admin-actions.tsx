'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { primaryButtonClass, secondaryButtonClass, inputClass } from '@/components/admin/ui'
import type { BarterSkillTaskPostStatus } from '@/types'

interface SkillTaskAdminActionsProps {
  postId: string
  status: BarterSkillTaskPostStatus
}

/** Mirrors src/components/barter/barter-admin-actions.tsx's exact pattern -- useState + fetch + reason prompt + router.refresh(). */
export function SkillTaskAdminActions({ postId, status }: SkillTaskAdminActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  async function call(action: 'suspend' | 'restore') {
    if (!reason.trim()) {
      setError('A reason is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/barter/skill-task/${postId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Action failed')
        return
      }
      router.refresh()
    } catch {
      setError('Action failed — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4 space-y-3 bg-[#FAF8F5] dark:bg-[#1A1010]">
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <input
        type="text"
        placeholder="Reason (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className={`w-full ${inputClass}`}
      />
      <div className="flex flex-wrap gap-2">
        {status === 'suspended' ? (
          <button disabled={busy} onClick={() => call('restore')} className={primaryButtonClass}>
            Restore
          </button>
        ) : (
          <button disabled={busy} onClick={() => call('suspend')} className={secondaryButtonClass}>
            Suspend post
          </button>
        )}
      </div>
    </div>
  )
}
