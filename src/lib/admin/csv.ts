/**
 * Minimal CSV serialization — no spreadsheet library, per the brief
 * ("do not add spreadsheet-generation libraries if basic CSV is
 * sufficient"). Every caller passes only the columns it has already
 * decided are export-safe; this function does not decide what's
 * sensitive, it just serializes what it's given.
 *
 * Step 11 Phase 7: a leading =/+/-/@ (or tab/CR, the same formula-
 * injection vectors Excel/Sheets recognize) is prefixed with a literal
 * single quote before quoting -- a spreadsheet then renders the cell as
 * text instead of evaluating it as a formula. Applies to every CSV
 * export in this codebase, not just affiliate's, since they all share
 * this one function.
 */
export function toCsv<T extends object>(columns: (keyof T & string)[], rows: T[]): string {
  const escape = (value: unknown): string => {
    let s = value === null || value === undefined ? '' : String(value)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
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
