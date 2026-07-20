import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FAF8F5] flex flex-col">
      {/* Top wordmark */}
      <header className="flex justify-center px-6 pt-10 pb-4">
        <Link href="/" className="text-[#8B1A1A] font-extrabold text-2xl tracking-tight">
          UNITY
        </Link>
      </header>

      {/* Page content */}
      <main className="flex-1 flex flex-col items-center px-4 pt-8 pb-16">
        {children}
      </main>
    </div>
  )
}
