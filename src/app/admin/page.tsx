import Link from 'next/link'
import {
  ADMIN_MOCK_STATS,
  ADMIN_MOCK_USERS,
  ADMIN_MOCK_BOOKINGS,
} from '@/lib/mock/admin-data'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString('en-ZA')
}

function fmtR(n: number) {
  return `R${n.toLocaleString('en-ZA')}`
}

function today() {
  return new Date().toLocaleDateString('en-ZA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

// ─── Badge components ─────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    renter:   'bg-blue-100  text-blue-700  dark:bg-blue-900/40  dark:text-blue-300',
    merchant: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
    admin:    'bg-[#8B1A1A]/10 text-[#8B1A1A] dark:bg-[#8B1A1A]/30 dark:text-red-300',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide ${map[role] ?? ''}`}>
      {role}
    </span>
  )
}

function KycBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    approved:   'bg-green-100  text-green-700  dark:bg-green-900/40  dark:text-green-300',
    pending:    'bg-amber-100  text-amber-700  dark:bg-amber-900/40  dark:text-amber-300',
    unverified: 'bg-[#F2EDE8] text-[#9B8B85]  dark:bg-[#2A1A1A]    dark:text-[#6B5B55]',
    rejected:   'bg-red-100   text-red-700    dark:bg-red-900/40    dark:text-red-300',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? ''}`}>
      {status}
    </span>
  )
}

function BookingStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending:   'bg-amber-100 text-amber-700  dark:bg-amber-900/40  dark:text-amber-300',
    active:    'bg-blue-100  text-blue-700   dark:bg-blue-900/40   dark:text-blue-300',
    completed: 'bg-green-100 text-green-700  dark:bg-green-900/40  dark:text-green-300',
    disputed:  'bg-red-100   text-red-700    dark:bg-red-900/40    dark:text-red-300',
    cancelled: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A]    dark:text-[#6B5B55]',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? ''}`}>
      {status}
    </span>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  valueClass,
  children,
}: {
  label: string
  value: string
  valueClass?: string
  children?: React.ReactNode
}) {
  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
        {label}
      </p>
      <p className={`text-4xl font-extrabold ${valueClass ?? 'text-[#1A0A0A] dark:text-[#F5F0ED]'}`}>
        {value}
      </p>
      {children && <div className="mt-3 space-y-1">{children}</div>}
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[#6B5B55] dark:text-[#9B8B85]">{label}</span>
      <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{value}</span>
    </div>
  )
}

function ProgressBar({ value, max, color = '#8B1A1A' }: { value: number; max: number; color?: string }) {
  const pct = Math.round((value / max) * 100)
  return (
    <div className="w-full bg-[#F2EDE8] dark:bg-[#2A1A1A] rounded-full h-2">
      <div
        className="h-2 rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminOverviewPage() {
  const s = ADMIN_MOCK_STATS

  // Derive recent signups (sorted by created_at desc, last 10)
  const recentSignups = [...ADMIN_MOCK_USERS]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10)

  // Recent bookings (last 10)
  const recentBookings = [...ADMIN_MOCK_BOOKINGS]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10)

  // Platform health derived stats
  const kycApprovalRate = Math.round((s.users.kyc_approved / s.users.total) * 100)
  const avgRentalValue = s.revenue.average_booking
  const disputeRate = Math.round((s.bookings.disputed / (s.bookings.completed + s.bookings.disputed)) * 100)

  return (
    <div className="p-6 lg:p-8 max-w-[1400px] space-y-8">

      {/* ── Page Header ── */}
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
          PLATFORM OVERVIEW
        </p>
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
          OVERVIEW
        </h1>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">{today()}</p>
      </div>

      {/* ── Primary Stats Grid ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Users */}
        <StatCard label="Total Users" value={fmt(s.users.total)}>
          <MiniStat label="Renters"   value={s.users.renters} />
          <MiniStat label="Merchants" value={s.users.merchants} />
        </StatCard>

        {/* Active Listings */}
        <StatCard label="Active Listings" value={fmt(s.listings.total)}>
          <MiniStat label="Active"  value={s.listings.active} />
          <MiniStat label="Paused"  value={s.listings.paused} />
          <MiniStat label="Draft"   value={s.listings.draft} />
        </StatCard>

        {/* Total Bookings */}
        <StatCard label="Total Bookings" value={fmt(s.bookings.total)}>
          <MiniStat label="Pending"   value={s.bookings.pending} />
          <MiniStat label="Active"    value={s.bookings.active} />
          <MiniStat label="Completed" value={s.bookings.completed} />
          <MiniStat label="Disputed"  value={s.bookings.disputed} />
        </StatCard>

        {/* Gross Revenue */}
        <StatCard
          label="Gross Revenue"
          value={fmtR(s.revenue.gross_total)}
          valueClass="text-4xl font-extrabold text-[#8B1A1A]"
        >
          <MiniStat label="+ This month" value={fmtR(s.revenue.this_month)} />
          <MiniStat label="Last month"   value={fmtR(s.revenue.last_month)} />
        </StatCard>
      </div>

      {/* ── Secondary Stats Row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Open Disputes */}
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
            Open Disputes
          </p>
          <p className={`text-4xl font-extrabold ${s.disputes.open > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-[#1A0A0A] dark:text-[#F5F0ED]'}`}>
            {s.disputes.open}
          </p>
          <div className="mt-3 space-y-1">
            <MiniStat label="Escalated"        value={s.disputes.escalated} />
            <MiniStat label="Pending Evidence" value={s.disputes.pending_evidence} />
          </div>
        </div>

        {/* Affiliate Payouts Pending */}
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
            Affiliate Payouts Pending
          </p>
          <p className="text-4xl font-extrabold text-[#8B1A1A]">
            {fmtR(s.affiliates.pending_payouts)}
          </p>
          <div className="mt-3 space-y-1">
            <MiniStat label="Active affiliates"  value={s.affiliates.active} />
            <MiniStat label="Total paid out"     value={fmtR(s.affiliates.total_commission_paid)} />
          </div>
        </div>

        {/* Verified Users */}
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
            Verified Users
          </p>
          <p className="text-4xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">
            {s.users.kyc_approved}
            <span className="text-xl text-[#9B8B85] ml-2">/ {s.users.total}</span>
          </p>
          <div className="mt-3 space-y-1">
            <MiniStat label="Verification rate" value={`${kycApprovalRate}%`} />
            <MiniStat label="Pending"           value={s.users.kyc_pending} />
          </div>
        </div>
      </div>

      {/* ── Recent Signups ── */}
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">
              Recent Activity
            </p>
            <h2 className="text-base font-bold text-[#1A0A0A] dark:text-[#F5F0ED] mt-0.5">
              Recent Signups
            </h2>
          </div>
          <Link
            href="/admin/users"
            className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#8B1A1A] hover:underline"
          >
            View All →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[#FAF8F5] dark:bg-[#0F0A0A]">
              <tr>
                {['Name', 'Email', 'Role', 'KYC', 'Joined'].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A]">
              {recentSignups.map((u) => (
                <tr
                  key={u.id}
                  className="hover:bg-[#FAF8F5] dark:hover:bg-[#0F0A0A] transition-colors"
                >
                  <td className="px-5 py-3">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:text-[#8B1A1A] dark:hover:text-[#C4511F]"
                    >
                      {u.full_name}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                    {u.email}
                  </td>
                  <td className="px-5 py-3">
                    <RoleBadge role={u.role} />
                  </td>
                  <td className="px-5 py-3">
                    <KycBadge status={u.kyc_status} />
                  </td>
                  <td className="px-5 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                    {new Date(u.created_at).toLocaleDateString('en-ZA', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Recent Bookings ── */}
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">
              Recent Activity
            </p>
            <h2 className="text-base font-bold text-[#1A0A0A] dark:text-[#F5F0ED] mt-0.5">
              Recent Bookings
            </h2>
          </div>
          <Link
            href="/admin/bookings"
            className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#8B1A1A] hover:underline"
          >
            View All →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[#FAF8F5] dark:bg-[#0F0A0A]">
              <tr>
                {['Item', 'Renter', 'Merchant', 'Amount', 'Status', 'Date'].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A]">
              {recentBookings.map((b) => (
                <tr
                  key={b.id}
                  className="hover:bg-[#FAF8F5] dark:hover:bg-[#0F0A0A] transition-colors"
                >
                  <td className="px-5 py-3">
                    <Link
                      href={`/admin/bookings/${b.id}`}
                      className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:text-[#8B1A1A] dark:hover:text-[#C4511F] max-w-[200px] block truncate"
                    >
                      {b.listing_title}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                    {b.renter_name}
                  </td>
                  <td className="px-5 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                    {b.merchant_name}
                  </td>
                  <td className="px-5 py-3 text-sm font-semibold text-[#8B1A1A]">
                    {fmtR(b.total_amount)}
                  </td>
                  <td className="px-5 py-3">
                    <BookingStatusBadge status={b.status} />
                  </td>
                  <td className="px-5 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                    {new Date(b.created_at).toLocaleDateString('en-ZA', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Platform Health ── */}
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">
          Platform Health
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* KYC Approval Rate */}
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">
              KYC Approval Rate
            </p>
            <p className="text-4xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">
              {kycApprovalRate}%
            </p>
            <ProgressBar value={s.users.kyc_approved} max={s.users.total} />
            <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
              {s.users.kyc_approved} of {s.users.total} users verified
            </p>
          </div>

          {/* Avg Rental Value */}
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">
              Avg Rental Value
            </p>
            <p className="text-4xl font-extrabold text-[#8B1A1A]">
              {fmtR(avgRentalValue)}
            </p>
            <ProgressBar value={avgRentalValue} max={5000} color="#C4511F" />
            <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
              Per completed booking
            </p>
          </div>

          {/* Dispute Rate */}
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">
              Dispute Rate
            </p>
            <p className={`text-4xl font-extrabold ${disputeRate > 10 ? 'text-red-600 dark:text-red-400' : 'text-[#1A0A0A] dark:text-[#F5F0ED]'}`}>
              {disputeRate}%
            </p>
            <ProgressBar value={disputeRate} max={100} color={disputeRate > 10 ? '#DC2626' : '#8B1A1A'} />
            <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
              {s.bookings.disputed} disputes of {s.bookings.completed + s.bookings.disputed} closed bookings
            </p>
          </div>
        </div>
      </div>

    </div>
  )
}
