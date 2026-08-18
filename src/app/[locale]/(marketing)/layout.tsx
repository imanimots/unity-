import { Navbar } from '@/components/shared/navbar'
import { Footer } from '@/components/shared/footer'
import { isPersonalizationEnabled } from '@/lib/personalization/config'

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar personalizationEnabled={isPersonalizationEnabled()} />
      <main id="main-content" className="pt-16">{children}</main>
      <Footer />
    </>
  )
}
