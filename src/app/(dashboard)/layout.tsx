import { Navbar } from '@/components/shared/navbar'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <main className="pt-16 min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">
        <div className="pt-8 pb-16">
          {children}
        </div>
      </main>
    </>
  )
}
