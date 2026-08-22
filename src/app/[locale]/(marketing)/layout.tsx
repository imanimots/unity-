import { Navbar } from '@/components/shared/navbar'
import { Footer } from '@/components/shared/footer'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { isRentToBuyEnabled } from '@/lib/rent-to-buy/config'

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar personalizationEnabled={isPersonalizationEnabled()} rentToBuyEnabled={isRentToBuyEnabled()} />
      <main id="main-content" className="pt-16">{children}</main>
      <Footer />
    </>
  )
}
