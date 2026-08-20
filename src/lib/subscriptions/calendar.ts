import type { SupabaseClient } from '@supabase/supabase-js'

export interface MerchantCalendarListing {
  id: string
  title: string
  status: string
}

export interface MerchantCalendarBooking {
  id: string
  listingId: string
  listingTitle: string
  startDate: string
  endDate: string
  status: string
}

export interface MerchantCalendarSchedule {
  id: string
  entityType: string
  entityId: string
  scheduledAt: string
  status: string
  blockReason: string | null
}

export interface MerchantCalendarView {
  listings: MerchantCalendarListing[]
  upcomingBookings: MerchantCalendarBooking[]
  scheduledPublications: MerchantCalendarSchedule[]
}

/**
 * Merchant inventory/calendar view (Pro/Elite, Section 9-10) --
 * genuinely built from existing authoritative data only. Unity has no
 * stock-quantity/ERP concept, so this deliberately does NOT invent one
 * -- it shows listing status, real upcoming bookings (from the
 * authoritative bookings table, not a second calendar), and scheduled
 * publication dates. Server-side entitlement is enforced by the
 * calling route, not here.
 */
export async function getMerchantCalendarView(supabase: SupabaseClient, merchantId: string): Promise<MerchantCalendarView> {
  const today = new Date().toISOString().slice(0, 10)

  const [{ data: listings }, { data: bookings }, { data: schedules }] = await Promise.all([
    supabase.from('listings').select('id, title, status').eq('merchant_id', merchantId).eq('is_test', false).order('created_at', { ascending: false }).limit(200),
    supabase
      .from('bookings')
      .select('id, listing_id, start_date, end_date, status, listing:listings(title)')
      .eq('merchant_id', merchantId)
      .in('status', ['confirmed', 'active'])
      .gte('end_date', today)
      .order('start_date', { ascending: true })
      .limit(100),
    supabase.from('merchant_scheduled_publications').select('id, entity_type, entity_id, scheduled_at, status, block_reason').eq('merchant_id', merchantId).order('scheduled_at', { ascending: true }).limit(100),
  ])

  return {
    listings: (listings ?? []).map((l) => ({ id: l.id, title: l.title, status: l.status })),
    upcomingBookings: ((bookings ?? []) as unknown as { id: string; listing_id: string; start_date: string; end_date: string; status: string; listing: { title: string } | null }[]).map((b) => ({
      id: b.id,
      listingId: b.listing_id,
      listingTitle: b.listing?.title ?? '',
      startDate: b.start_date,
      endDate: b.end_date,
      status: b.status,
    })),
    scheduledPublications: (schedules ?? []).map((s) => ({ id: s.id, entityType: s.entity_type, entityId: s.entity_id, scheduledAt: s.scheduled_at, status: s.status, blockReason: s.block_reason })),
  }
}
