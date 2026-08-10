'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  agreementId: string
  status: string
  possessionStatus: string
  pendingReturnCaseId: string | null
}

async function callAction(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'Something went wrong')
  return json
}

export function RentToBuyAdminActions({ agreementId, status, possessionStatus, pendingReturnCaseId }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const run = async (key: string, path: string, body: Record<string, unknown> = {}) => {
    setBusy(key)
    setError(null)
    try {
      await callAction(path, body)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  const base = `/api/admin/rent-to-buy/${agreementId}`
  const btn = 'px-4 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-[0.08em] transition-colors disabled:opacity-50'
  const primary = `${btn} bg-[#8B1A1A] text-white hover:bg-[#7A1616]`
  const secondary = `${btn} border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:border-[#8B1A1A]/40`

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-[#8B1A1A]">{error}</p>}
      {status === 'active' && (
        <div className="flex gap-2 items-center">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for default (required)" className="flex-1 px-3 py-2 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] text-sm bg-white dark:bg-[#1A1010]" />
          <button className={primary} disabled={busy !== null || !reason.trim()} onClick={() => run('default', `${base}/default`, { reason })}>Mark defaulted</button>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {possessionStatus === 'return_in_progress' && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('confirm-return', `${base}/confirm-return`, { case_id: pendingReturnCaseId })}>Confirm item returned</button>
        )}
        {(possessionStatus === 'return_required' || possessionStatus === 'return_in_progress') && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('recovery', `${base}/create-recovery-case`)}>Create recovery case (manual)</button>
        )}
      </div>
    </div>
  )
}
