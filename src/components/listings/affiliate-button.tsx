'use client'

import { useState } from 'react'
import { Link2, Check, Copy } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'

interface AffiliateButtonProps {
  listingId: string
  listingTitle: string
}

export function AffiliateButton({ listingId, listingTitle }: AffiliateButtonProps) {
  const { profile } = useAuth()
  const [copied, setCopied] = useState(false)

  const affiliateCode = profile?.affiliate_code
    || (typeof window !== 'undefined' ? localStorage.getItem('unity_affiliate_code') : null)

  if (!affiliateCode) return null

  const link = `${typeof window !== 'undefined' ? window.location.origin : ''}/listings/${listingId}?ref=${affiliateCode}`

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select text
    }
  }

  return (
    <div className="rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#1A1010] p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-lg bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center">
          <Link2 size={14} className="text-[#8B1A1A]" />
        </div>
        <p className="text-sm font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">Your affiliate link</p>
        <span className="ml-auto text-xs font-medium text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-2 py-0.5 rounded-full">
          {affiliateCode}
        </span>
      </div>
      <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mb-3">
        Share this link to earn a commission on every booking you refer for &quot;{listingTitle}&quot;.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-3 py-2 truncate text-[#6B5B55] dark:text-[#9B8B85]">
          {link}
        </code>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#8B1A1A] text-white text-xs font-semibold hover:bg-[#7A1616] transition-colors shrink-0"
        >
          {copied ? <><Check size={13} /> Copied!</> : <><Copy size={13} /> Copy</>}
        </button>
      </div>
    </div>
  )
}
