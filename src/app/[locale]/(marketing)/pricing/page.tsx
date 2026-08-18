import { getTranslations, getLocale } from 'next-intl/server'
import { Check } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getServerUser } from '@/lib/data/profiles'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantSubscriptionPlans } from '@/lib/subscriptions/plans'
import { getEffectiveMerchantPlan } from '@/lib/subscriptions/effective-plan'
import { formatMoney } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'
import type { MerchantSubscriptionPlan } from '@/types'

export const metadata = { title: 'Merchant Pricing — Unity' }
// Always live: plan rates are read from the database (never build-time
// frozen) and the page personalizes for a signed-in merchant's current
// plan via the session cookie -- not a candidate for static generation.
export const dynamic = 'force-dynamic'

function bps(n: number): string {
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 1)}%`
}

type PricingT = Awaited<ReturnType<typeof getTranslations<'merchant.pricing'>>>

function planFeatures(plan: MerchantSubscriptionPlan, t: PricingT): string[] {
  const features = [
    t('salesCommission', { rate: bps(plan.sales_commission_bps) }),
    t('rentalCommission', { rate: bps(plan.rental_commission_bps) }),
    t('noBarterCommission'),
    plan.active_listing_limit ? t('upToListings', { count: plan.active_listing_limit }) : t('unlimitedListings'),
  ]
  return features
}

/**
 * Public plan catalogue, always read live from merchant_subscription_plans
 * -- never a hardcoded copy of the rates (see src/lib/subscriptions/plans.ts).
 * If the visitor is signed in as a merchant, their current plan is
 * highlighted; all actions (upgrade/downgrade/cancel) live on
 * /dashboard/merchant/subscription, not here -- this page is informational.
 */
export default async function PricingPage() {
  const t = await getTranslations('merchant.pricing')
  const locale = (await getLocale()) as Locale
  const admin = await getAdminServiceClient()
  if (!admin) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-24 text-center">
        <p className="text-sm text-[#9B8B85]">{t('unavailable')}</p>
      </div>
    )
  }

  const plans = await getMerchantSubscriptionPlans(admin)

  const { profile } = await getServerUser()
  let currentPlanId: string | null = null
  if (profile && (profile.role === 'merchant' || profile.role === 'both')) {
    const effective = await getEffectiveMerchantPlan(admin, profile.id)
    currentPlanId = effective.planId
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <div className="text-center mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('sectionLabel')}</p>
        <h1 className="text-3xl lg:text-5xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-4">{t('heading')}</h1>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] max-w-xl mx-auto">
          {t('subheading')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {plans.map((plan) => {
          const isCurrent = currentPlanId === plan.id
          const isFeatured = plan.id === 'pro'
          return (
            <div
              key={plan.id}
              className={`rounded-2xl p-8 border ${
                isFeatured ? 'bg-[#8B1A1A] border-[#8B1A1A] text-white' : 'bg-white dark:bg-[#1A1010] border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED]'
              }`}
            >
              {isCurrent && (
                <span className="inline-block mb-4 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-[0.1em] bg-white/20 text-inherit">
                  {t('currentPlan')}
                </span>
              )}
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] opacity-70 mb-2">{plan.display_name}</p>
              <div className="mb-6">
                <span className="text-4xl font-extrabold">{plan.monthly_fee_cents === 0 ? t('free') : formatMoney(plan.monthly_fee_cents, 'ZAR', locale)}</span>
                {plan.monthly_fee_cents > 0 && <span className="text-sm opacity-70">{t('perMonth')}</span>}
              </div>
              <ul className="space-y-3 mb-8">
                {planFeatures(plan, t).map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check size={16} className="shrink-0 mt-0.5 opacity-80" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Link
                href={profile ? '/dashboard/merchant/subscription' : '/register'}
                className={`block text-center px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] transition-colors ${
                  isFeatured ? 'bg-white text-[#8B1A1A] hover:bg-white/90' : 'bg-[#8B1A1A] text-white hover:bg-[#7A1616]'
                }`}
              >
                {isCurrent ? t('managePlan') : profile ? t('changePlan') : t('getStarted')}
              </Link>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-[#9B8B85] text-center mt-12">
        {t('footerNotice')}
      </p>
    </div>
  )
}
