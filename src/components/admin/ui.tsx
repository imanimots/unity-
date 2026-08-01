export function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' })
}

export function formatDateTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatMoney(amount: number | null, currency = 'ZAR') {
  if (amount === null || amount === undefined) return '—'
  const symbol = currency === 'ZAR' ? 'R' : `${currency} `
  return `${symbol}${amount.toLocaleString('en-ZA')}`
}

export function Pill({ value, styles }: { value: string; styles: Record<string, string> }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize whitespace-nowrap ${styles[value] ?? 'bg-[#F2EDE8] text-[#6B5B55]'}`}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

export const ACCOUNT_STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  restricted: 'bg-amber-100 text-amber-700',
  suspended: 'bg-red-100 text-red-700',
}

export const SEVERITY_STYLES: Record<string, string> = {
  low: 'bg-[#F2EDE8] text-[#6B5B55]',
  medium: 'bg-amber-100 text-amber-700',
  high: 'bg-red-100 text-red-700',
}

export function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{label}</p>
      <p className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{value}</p>
    </div>
  )
}

export function AdminPageHeader({ eyebrow, title, badge }: { eyebrow: string; title: string; badge?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">{eyebrow}</p>
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">{title}</h1>
      </div>
      {badge ? (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          <span className="text-[11px] font-medium text-amber-700 uppercase tracking-[0.1em]">{badge}</span>
        </div>
      ) : null}
    </div>
  )
}

export const inputClass =
  'bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]'

export const primaryButtonClass =
  'inline-flex items-center gap-1 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed'

export const secondaryButtonClass =
  'inline-flex items-center gap-1 bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed'

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `key-${Date.now()}-${Math.random()}`
}
