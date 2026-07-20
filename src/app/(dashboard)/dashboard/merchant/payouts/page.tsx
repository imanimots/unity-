import Link from 'next/link'
import { DollarSign, Clock, CheckCircle, ArrowRight, Building2, AlertCircle, ArrowLeft } from 'lucide-react'
import { MOCK_MERCHANT_BOOKINGS } from '@/lib/mock/data'

export const metadata = { title: 'Payouts — Unity' }

const MOCK_PAYOUT_HISTORY = [
  { id: 'pay-1', amount: 1200,  date: '2026-05-30', status: 'paid',    ref: 'UNI-PAY-0041', booking: 'Nikon Z6 II · 4 days' },
  { id: 'pay-2', amount: 500,   date: '2026-04-18', status: 'paid',    ref: 'UNI-PAY-0028', booking: 'Campmaster Tent · 5 days' },
  { id: 'pay-3', amount: 2100,  date: '2026-03-05', status: 'paid',    ref: 'UNI-PAY-0019', booking: 'Nikon Z6 II · 7 days' },
]

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function PayoutsPage() {
  const completedBookings = MOCK_MERCHANT_BOOKINGS.filter((b) => b.status === 'returned')
  const activeBookings    = MOCK_MERCHANT_BOOKINGS.filter((b) => b.status === 'active')

  const availableBalance = completedBookings.reduce((sum, b) => sum + b.rental_fee, 0)
  const inEscrow         = activeBookings.reduce((sum, b) => sum + b.total_amount, 0)
  const allTimePaid      = MOCK_PAYOUT_HISTORY.reduce((sum, p) => sum + p.amount, 0)

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Back */}
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      {/* Page heading */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Earnings</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          Payouts
        </h1>
      </div>

      {/* Available balance — featured metric */}
      <div className="bg-[#8B1A1A] rounded-xl p-8 mb-12 border-l-4 border-l-[#C4511F]">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-white/60 mb-3">Available Balance</p>
        <div className="text-5xl lg:text-6xl font-extrabold text-white leading-none mb-2">
          R{availableBalance}
        </div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/50">Ready to withdraw</p>
        {availableBalance > 0 && (
          <button className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold uppercase tracking-[0.1em] rounded-xl transition-colors">
            Withdraw Funds <ArrowRight size={14} />
          </button>
        )}
      </div>

      {/* Secondary balance stats */}
      <div className="grid grid-cols-2 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">In Escrow</p>
            <Clock size={14} className="text-amber-400" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{inEscrow}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">Released on return</p>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">All-Time Paid</p>
            <CheckCircle size={14} className="text-green-400" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{allTimePaid}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{MOCK_PAYOUT_HISTORY.length} payouts</p>
        </div>
      </div>

      {/* Bank account setup */}
      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 mb-12">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center">
              <Building2 size={18} className="text-[#6B5B55] dark:text-[#9B8B85]" />
            </div>
            <div>
              <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Bank account</p>
              <p className="text-xs text-[#9B8B85]">Not yet configured</p>
            </div>
          </div>
          <button className="px-3 py-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-lg hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors flex items-center gap-1.5">
            Add Account <ArrowRight size={12} />
          </button>
        </div>

        <div className="mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A] flex items-start gap-2">
          <AlertCircle size={13} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-[#9B8B85]">
            You need a verified bank account to receive payouts. Unity supports all major South African banks.
            Bank details are encrypted and handled securely.
          </p>
        </div>
      </div>

      {/* Payout history */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-5">Payout History</p>

        {MOCK_PAYOUT_HISTORY.length === 0 ? (
          <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-12 text-center">
            <DollarSign size={32} className="mx-auto text-[#9B8B85] mb-3" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">No payouts yet. Complete a rental to start earning.</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
            {MOCK_PAYOUT_HISTORY.map((p) => (
              <div key={p.id} className="flex items-center gap-4 px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
                <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
                  <CheckCircle size={14} className="text-green-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{p.booking}</p>
                  <p className="text-xs text-[#9B8B85] mt-0.5">{p.ref} · {formatDate(p.date)}</p>
                </div>
                <div className="shrink-0 font-semibold text-green-600 dark:text-green-400 text-sm">
                  +R{p.amount}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Unity fee note */}
      <div className="p-4 bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
        <p className="text-xs text-[#9B8B85] leading-relaxed">
          Unity charges a <strong className="text-[#6B5B55] dark:text-[#9B8B85]">5% platform fee</strong> on each completed rental, deducted before payout.
          Deposits and insurance fees are collected from renters and handled separately.
          <Link href="/pricing" className="text-[#8B1A1A] underline ml-1 hover:no-underline">Learn more</Link>
        </p>
      </div>
    </div>
  )
}
