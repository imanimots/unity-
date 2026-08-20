/**
 * Shared CSV utilities for merchant listing export/import (Pro/Elite
 * only, Section 5-7). Stable, documented columns -- the same list is
 * used for both directions so an exported file can be re-imported
 * unchanged.
 */
export const LISTING_CSV_COLUMNS = [
  'id',
  'title',
  'description',
  'category',
  'condition',
  'listing_type',
  'daily_rate',
  'weekly_rate',
  'monthly_rate',
  'sale_price',
  'province',
  'city',
  'status',
] as const

export type ListingCsvColumn = (typeof LISTING_CSV_COLUMNS)[number]

/**
 * Prevents spreadsheet formula injection (Section 7/CSV export): a cell
 * beginning with =, +, -, @, tab, or CR is prefixed with a single quote
 * so Excel/Sheets/LibreOffice render it as literal text, never execute
 * it as a formula, matching the standard OWASP CSV-injection mitigation.
 * Applied to every field, not just user-authored ones, since any value
 * could in principle start with a dangerous prefix.
 */
export function csvSafeCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value)
  const dangerous = /^[=+\-@\t\r]/.test(raw)
  const escaped = dangerous ? `'${raw}` : raw
  const needsQuoting = /[",\n]/.test(escaped)
  return needsQuoting ? `"${escaped.replace(/"/g, '""')}"` : escaped
}

export function toCsvRow(values: (string | number | null | undefined)[]): string {
  return values.map(csvSafeCell).join(',')
}

export function buildListingsCsv(rows: Record<string, unknown>[]): string {
  const header = toCsvRow([...LISTING_CSV_COLUMNS])
  const lines = rows.map((row) => toCsvRow(LISTING_CSV_COLUMNS.map((col) => row[col] as string | number | null | undefined)))
  return [header, ...lines].join('\r\n') + '\r\n'
}

/** Minimal, dependency-free CSV row parser -- handles quoted fields and escaped quotes, sufficient for the fixed column set above. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}
