import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { LanguageSelector } from '@/components/shared/language-selector'
import { CountrySelector } from '@/components/shared/country-selector'

export function Footer() {
  const t = useTranslations('navigation')

  return (
    <footer className="bg-[#FAF8F5] border-t border-[#F2EDE8] mt-20 mb-16 md:mb-0">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">

        {/* Main row: logo left, links right */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-10">

          {/* Brand */}
          <div className="shrink-0">
            <Link href="/" className="inline-block">
              <span className="text-[#8B1A1A] font-extrabold text-xl tracking-tight">UNITY</span>
            </Link>
            <p className="text-xs text-[#9B8B85] mt-3 leading-relaxed max-w-[180px] uppercase tracking-[0.05em]">
              {t('footer.tagline')}
            </p>
          </div>

          {/* Link groups */}
          <div className="flex flex-wrap gap-x-12 gap-y-8">

            {/* Platform */}
            <div>
              <h2 className="section-label text-[#9B8B85] mb-4">{t('footer.platform')}</h2>
              <ul className="space-y-2.5">
                <li><Link href="/#how-it-works" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('howItWorks')}</Link></li>
                <li><Link href="/listings" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('browse')}</Link></li>
                <li><Link href="/register?role=merchant" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.becomeMerchant')}</Link></li>
              </ul>
            </div>

            {/* Trust */}
            <div>
              <h2 className="section-label text-[#9B8B85] mb-4">{t('footer.trust')}</h2>
              <ul className="space-y-2.5">
                <li><Link href="/verification-and-trust" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.verificationAndTrust')}</Link></li>
                <li><Link href="/prohibited-items" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.prohibitedItems')}</Link></li>
                <li><Link href="/disputes" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.disputes')}</Link></li>
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h2 className="section-label text-[#9B8B85] mb-4">{t('footer.legal')}</h2>
              <ul className="space-y-2.5">
                <li><Link href="/terms" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.terms')}</Link></li>
                <li><Link href="/privacy" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.privacy')}</Link></li>
                <li><Link href="/popia" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.popia')}</Link></li>
                <li><Link href="/rental-terms" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.rentalTerms')}</Link></li>
                <li><Link href="/payments-and-deposits" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.paymentsAndDeposits')}</Link></li>
                <li><Link href="/cancellations" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.cancellations')}</Link></li>
                <li><Link href="/refunds" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.refunds')}</Link></li>
                <li><Link href="/delivery-and-handover" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.deliveryAndHandover')}</Link></li>
              </ul>
            </div>

            {/* Support */}
            <div>
              <h2 className="section-label text-[#9B8B85] mb-4">{t('footer.support')}</h2>
              <ul className="space-y-2.5">
                <li><Link href="/help" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.helpCenter')}</Link></li>
                <li><Link href="/sitemap" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.sitemap')}</Link></li>
                <li><Link href="/contact" className="text-sm text-[#6B5B55] hover:text-[#1A0A0A] transition-colors">{t('footer.contact')}</Link></li>
              </ul>
            </div>

          </div>
        </div>

        {/* Bottom bar — language/country live here, not in the public
            navbar (E47 Phase E/G): a signed-in member also finds them in
            Account Settings, but an anonymous visitor only ever reaches
            this footer, so CLAUDE.md's binding "country selector in UI"
            requirement stays satisfied for every visitor, not only
            signed-in ones. */}
        <div className="border-t border-[#F2EDE8] mt-10 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-[#9B8B85] uppercase tracking-[0.06em]">© {new Date().getFullYear()} Unity. {t('footer.rightsReserved')}</p>
          <div className="flex items-center gap-1">
            <LanguageSelector />
            <CountrySelector />
          </div>
        </div>

      </div>
    </footer>
  )
}
