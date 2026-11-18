/**
 * Converts a calendar date the user picked in the browser (e.g. from
 * react-day-picker) into a plain YYYY-MM-DD string for search's
 * date-only availability filter (search_listings.p_start_date/
 * p_end_date are `date` columns, not `timestamptz`).
 *
 * Deliberately reads the Date's own LOCAL calendar fields
 * (getFullYear/getMonth/getDate) rather than `.toISOString()`, for the
 * same reason src/lib/bookings/date.ts's calendarDateToSastIso() does --
 * `.toISOString()` re-interprets the Date through the browser's own
 * timezone, which can silently shift the selected calendar day by one.
 */
export function calendarDateToIsoDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
