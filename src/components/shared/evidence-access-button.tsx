'use client'

import { useState } from 'react'

interface EvidenceAccessButtonProps {
  /** The resource-specific POST route that authorizes and signs this exact evidence file -- never a generic signer. */
  accessUrl: string
  label: string
  errorLabel: string
  className?: string
}

/**
 * The one user-facing action for viewing/downloading a private evidence
 * file, for both dispute evidence and RTB-native evidence. POSTs to a
 * resource-specific access route (never a generic bucket/path signer),
 * which authorizes under the resource's own existing RLS and returns a
 * short-lived signed URL -- opened directly, never persisted or logged
 * by this component.
 */
export function EvidenceAccessButton({ accessUrl, label, errorLabel, className }: EvidenceAccessButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(accessUrl, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.url) {
        setError(data?.error ?? errorLabel)
        return
      }
      window.open(data.url, '_blank', 'noopener,noreferrer')
    } catch {
      setError(errorLabel)
    } finally {
      setLoading(false)
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className={className ?? 'text-xs font-semibold text-[#8B1A1A] hover:underline disabled:opacity-50 disabled:hover:no-underline'}
      >
        {loading ? '…' : label}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  )
}
