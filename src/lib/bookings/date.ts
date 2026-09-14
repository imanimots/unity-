/**
 * Converts a calendar date the user picked in the browser (e.g. from
 * react-day-picker) into an ISO 8601 instant anchored to a fixed
 * +02:00 offset (Africa/Johannesburg, South Africa's only launch
 * timezone -- no DST, so the offset never varies).
 *
 * Deliberately reads the Date's own LOCAL calendar fields
 * (getFullYear/getMonth/getDate) rather than calling `.toISOString()` --
 * `.toISOString()` re-interprets the Date through whatever timezone the
 * browser's OS happens to be set to, which can silently shift the
 * selected calendar day by one when converted to UTC. Reading the local
 * fields and re-anchoring to an explicit +02:00 offset makes the result
 * correct regardless of the browser's own timezone setting.
 *
 * The picker only ever produces date-only selections (no time-of-day
 * input exists in the booking flow), so only the calendar date matters
 * here -- the time is always midnight.
 */
export function calendarDateToSastIso(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}T00:00:00+02:00`
}
