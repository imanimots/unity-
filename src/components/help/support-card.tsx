import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Headphones, ArrowRight } from 'lucide-react'

/** Server-rendered variant of the Help Centre's right-hand support card (Help Centre reference), reused on both /help and /help/[slug]. */
export async function SupportCard() {
  const t = await getTranslations('help.helpCenterPage')
  return (
    <div className="rounded-2xl border border-[#8B1A1A]/20 bg-[#8B1A1A]/[0.04] p-5">
      <Headphones size={20} className="text-[#8B1A1A] mb-3" />
      <p className="font-bold text-[#1A0A0A] text-sm mb-1.5">{t('stillNeedHelp')}</p>
      <p className="text-xs text-[#6B5B55] leading-relaxed mb-4">{t('stillNeedHelpDesc')}</p>
      <Link
        href="/contact"
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#8B1A1A] text-[#8B1A1A] text-xs font-semibold hover:bg-[#8B1A1A] hover:text-white transition-colors"
      >
        {t('contactSupport')} <ArrowRight size={12} />
      </Link>
    </div>
  )
}
