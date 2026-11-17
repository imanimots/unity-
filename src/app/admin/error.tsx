'use client'

import { useEffect } from 'react'
import { RotateCw } from 'lucide-react'
import { AdminPageHeader, secondaryButtonClass } from '@/components/admin/ui'

export default function AdminErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Something went wrong" title="Unexpected error" />
      <div className="bg-white border border-[#F2EDE8] rounded-xl p-10 text-center">
        <p className="text-sm text-[#6B5B55] mb-6">This page could not be loaded. You can try again below.</p>
        <button onClick={reset} className={secondaryButtonClass}>
          <RotateCw size={12} /> Try again
        </button>
      </div>
    </div>
  )
}
