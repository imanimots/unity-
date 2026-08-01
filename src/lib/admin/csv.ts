/**
 * Minimal CSV serialization — no spreadsheet library, per the brief
 * ("do not add spreadsheet-generation libraries if basic CSV is
 * sufficient"). Every caller passes only the columns it has already
 * decided are export-safe; this function does not decide what's
 * sensitive, it just serializes what it's given.
 */
export function toCsv<T extends object>(columns: (keyof T & string)[], rows: T[]): string {
  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? '' : String(value)
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const lines = [columns.map(escape).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c])).join(','))
  }
  return lines.join('\n')
}

export function csvResponse<T extends object>(filename: string, columns: (keyof T & string)[], rows: T[]): Response {
  const body = toCsv(columns, rows)
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
