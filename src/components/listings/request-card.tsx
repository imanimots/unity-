import Link from 'next/link'
import { MapPin, Clock } from 'lucide-react'

export interface MarketplaceRequestSummary {
  id: string
  transaction_type: 'buy' | 'rent' | 'barter'
  title: string
  category: string | null
  province: string | null
  city: string | null
  budget_min: number | null
  budget_max: number | null
  currency: string
  start_date: string | null
  end_date: string | null
  expires_at: string | null
  created_at: string
}

function formatBudget(min: number | null, max: number | null, currency: string): string | null {
  if (min === null && max === null) return null
  if (min !== null && max !== null) return `${currency} ${min}–${max}`
  return `${currency} ${min ?? max}`
}

/** No photos on a demand-side request -- deliberately a simpler card than ListingCard. */
export function RequestCard({ request }: { request: MarketplaceRequestSummary }) {
  const budget = formatBudget(request.budget_min, request.budget_max, request.currency)
  const location = [request.city, request.province].filter(Boolean).join(', ')

  return (
    <Link href={`/looking-for/${request.id}`} className="group block rounded-2xl border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-5 hover:border-[#8B1A1A]/40 transition-colors">
      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] mb-3">
        Looking to {request.transaction_type}
      </span>
      <h3 className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1 line-clamp-2">{request.title}</h3>
      {request.category && <p className="text-xs text-[#9B8B85] mb-2">{request.category}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
        {location && (
          <span className="flex items-center gap-1">
            <MapPin size={12} /> {location}
          </span>
        )}
        {budget && <span>{budget}</span>}
        {request.start_date && request.end_date && (
          <span>
            {request.start_date} – {request.end_date}
          </span>
        )}
        {request.expires_at && (
          <span className="flex items-center gap-1">
            <Clock size={12} /> Expires {new Date(request.expires_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </Link>
  )
}
