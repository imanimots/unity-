import { Navbar } from '@/components/shared/navbar'
import { Footer } from '@/components/shared/footer'

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <main id="main-content" className="pt-16">{children}</main>
      <Footer />
    </>
  )
}
