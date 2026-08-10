import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, Wallet } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'

export const metadata = { title: 'Rent-to-Buy — Unity' }

const STATUS_LABELS: Record<string, string> = {
  pending_merchant_acceptance: 'Awaiting merchant acceptance',
  awaiting_first_payment: 'Awaiting first payment',
  active: 'Active',
  defaulted: 'Defaulted',
  return_required: 'Return required',
  completed: 'Completed — you own this item',
  cancelled: 'Cancelled',
  disputed: 'Disputed',
}

export default async function RentToBuyInboxPage() {
  const requester = await requireAuth()
  if (!requester) redirect('/login?redirectTo=/dashboard/rent-to-buy')

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const { data } = supabase
    ? await supabase
        .from('rent_to_buy_agreements')
        .select('id, status, total_purchase_price, currency, created_at, listing:listings(title)')
        .or(`merchant_id.eq.${requester.userId},customer_id.eq.${requester.userId}`)
        .order('created_at', { ascending: false })
    : { data: [] }

  const agreements = (data ?? []) as unknown as { id: string; status: string; total_purchase_price: number; currency: string; created_at: string; listing?: { title: string } }[]

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Rent-to-Buy</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">Agreements</h1>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-3">
          {agreements.length} agreement{agreements.length !== 1 ? 's' : ''} total
        </p>
      </div>

      {agreements.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Wallet size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">No agreements yet</p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">Browse rent-to-buy listings to get started.</p>
          <Link href="/listings?mode=rent_to_buy" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
            Browse Listings
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {agreements.map((a) => (
            <Link
              key={a.id}
              href={`/dashboard/rent-to-buy/${a.id}`}
              className="block bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 hover:border-[#8B1A1A]/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
                <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                  {a.listing?.title ?? 'Item'}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]">
                  {STATUS_LABELS[a.status] ?? a.status}
                </span>
              </div>
              <p className="text-xs text-[#9B8B85]">
                {a.currency} {Number(a.total_purchase_price).toLocaleString()} total · {new Date(a.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
