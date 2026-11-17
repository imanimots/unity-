import Link from 'next/link'
import { Home, Search } from 'lucide-react'
import { Navbar } from '@/components/shared/navbar'

export const metadata = { title: 'Page not found — Unity' }

export default function NotFound() {
  return (
    <>
      <Navbar />
      <main className="min-h-[70vh] flex items-center justify-center px-4 pt-16">
        <div className="max-w-md text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Error 404</p>
          <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] tracking-tight mb-3">Page not found</h1>
          <p className="text-sm text-[#6B5B55] mb-8">
            The page you&apos;re looking for doesn&apos;t exist, may have been moved, or the item it was showing is no longer available.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-6 py-3 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors"
            >
              <Home size={14} /> Back to Unity
            </Link>
            <Link
              href="/listings"
              className="inline-flex items-center gap-2 px-6 py-3 bg-white border border-[#F2EDE8] text-[#1A0A0A] font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#FAF8F5] transition-colors"
            >
              <Search size={14} /> Browse listings
            </Link>
          </div>
        </div>
      </main>
    </>
  )
}
