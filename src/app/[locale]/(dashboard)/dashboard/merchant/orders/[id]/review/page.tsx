import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { loadReviewPageData } from '@/lib/reviews/page-data'
import { ReviewForm } from '@/components/reviews/review-form'

export const metadata = { title: 'Leave a Review — Unity' }

interface Props {
  params: Promise<{ id: string }>
}

/** Reviews V2 — Buy/order review (seller/merchant side). See the buyer page for the full design note. */
export default async function SellerOrderReviewPage({ params }: Props) {
  const { id } = await params
  const t = await getTranslations('reviews.form')
  const backHref = '/dashboard/merchant/orders'

  const requester = await getRequestProfile()
  const data = requester ? await loadReviewPageData('buy', id, requester.userId) : null

  if (!requester || !data) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A] flex items-center justify-center">
        <div className="max-w-lg mx-auto px-4 py-16 text-center">
          <p className="text-[#6B5B55] dark:text-[#9B8B85] font-['Plus_Jakarta_Sans']">{t('orderNotFound')}</p>
          <Link href={backHref} className="text-sm text-[#8B1A1A] hover:text-[#7A1616] underline mt-2 inline-block font-['Plus_Jakarta_Sans'] transition-colors">
            ← {t('backToOrders')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-3 mb-8">
          <Link href={backHref} className="p-1.5 rounded-lg text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] font-['Plus_Jakarta_Sans']">{t('leaveReview')}</h1>
            <p className="text-xs text-[#9B8B85] mt-0.5 font-['Plus_Jakarta_Sans']">{data.transactionTitle}</p>
          </div>
        </div>

        {data.alreadySubmitted && data.existingReview ? (
          <div className="max-w-lg mx-auto rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-6 text-center space-y-2">
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('alreadySubmittedTitle')}</p>
            <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{data.existingReview.publishedAt ? t('nowPublic') : t('submittedBlindExplainer')}</p>
          </div>
        ) : (
          <ReviewForm domain="buy" transactionId={id} revieweeName={data.revieweeName} transactionTitle={data.transactionTitle} backHref={backHref} />
        )}
      </div>
    </div>
  )
}
