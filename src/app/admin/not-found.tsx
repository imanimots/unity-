import Link from 'next/link'
import { Home } from 'lucide-react'
import { AdminPageHeader } from '@/components/admin/ui'

export const metadata = { title: 'Not found — Unity Admin' }

export default function AdminNotFound() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Error 404" title="Not found" />
      <div className="bg-white border border-[#F2EDE8] rounded-xl p-10 text-center">
        <p className="text-sm text-[#6B5B55] mb-6">
          This record doesn&apos;t exist, may have been removed, or the link is no longer valid.
        </p>
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-lg hover:bg-[#7A1616] transition-colors"
        >
          <Home size={14} /> Back to Overview
        </Link>
      </div>
    </div>
  )
}
