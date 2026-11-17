'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { RotateCw, Home } from 'lucide-react'

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="min-h-screen bg-[#FAF8F5] flex items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Something went wrong</p>
        <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] tracking-tight mb-3">An unexpected error occurred</h1>
        <p className="text-sm text-[#6B5B55] mb-8">
          Please try again. If this keeps happening, contact support.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 px-6 py-3 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors"
          >
            <RotateCw size={14} /> Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 bg-white border border-[#F2EDE8] text-[#1A0A0A] font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#FAF8F5] transition-colors"
          >
            <Home size={14} /> Back to Unity
          </Link>
        </div>
      </div>
    </main>
  )
}
