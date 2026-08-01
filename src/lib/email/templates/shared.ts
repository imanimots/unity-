/**
 * The one shared shell every catalogue template renders through
 * (src/lib/email/templates/catalogue.ts) -- Unity header, greeting,
 * optional transaction summary table, optional primary CTA button,
 * optional test-mode notice, support contact, and legal footer. No
 * catalogue entry hand-authors its own HTML wrapper; this is what keeps
 * ~30 templates from becoming ~30 near-duplicate HTML files. Every email
 * gets both an HTML and a plain-text rendering from the same input.
 */

export interface SummaryRow {
  label: string
  value: string
}

export interface ShellInput {
  preheader: string
  greeting: string
  bodyParagraphs: string[]
  summary?: { title: string; rows: SummaryRow[] }
  cta?: { label: string; path: string }
  testModeNotice?: boolean
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
const SUPPORT_EMAIL = 'support@unitytest.co.za'
const BRAND_RED = '#8B1A1A'
const TEXT_DARK = '#1A0A0A'
const TEXT_MUTED = '#6B5B55'
const BORDER = '#F2EDE8'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${APP_URL}${path.startsWith('/') ? path : `/${path}`}`
}

export function renderShell(input: ShellInput): { html: string; text: string } {
  const paragraphsHtml = input.bodyParagraphs.map((p) => `<p style="margin:0 0 16px;color:${TEXT_DARK};font-size:15px;line-height:1.6;">${escapeHtml(p)}</p>`).join('\n')
  const paragraphsText = input.bodyParagraphs.join('\n\n')

  const summaryHtml = input.summary
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid ${BORDER};border-radius:8px;overflow:hidden;">
      <tr><td style="background:#FAF8F5;padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9B8B85;">${escapeHtml(input.summary.title)}</td></tr>
      ${input.summary.rows
        .map(
          (row) =>
            `<tr><td style="padding:10px 16px;border-top:1px solid ${BORDER};font-size:14px;color:${TEXT_MUTED};">${escapeHtml(row.label)}</td><td style="padding:10px 16px;border-top:1px solid ${BORDER};font-size:14px;color:${TEXT_DARK};font-weight:600;text-align:right;">${escapeHtml(row.value)}</td></tr>`
        )
        .join('\n')}
    </table>`
    : ''
  const summaryText = input.summary
    ? `\n${input.summary.title}\n${input.summary.rows.map((r) => `- ${r.label}: ${r.value}`).join('\n')}\n`
    : ''

  const ctaUrl = input.cta ? absoluteUrl(input.cta.path) : null
  const ctaHtml = input.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${BRAND_RED};">
        <a href="${ctaUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;">${escapeHtml(input.cta.label)}</a>
      </td></tr></table>`
    : ''
  const ctaText = input.cta ? `\n${input.cta.label}: ${ctaUrl}\n` : ''

  const testModeHtml = input.testModeNotice
    ? `<p style="margin:20px 0 0;padding:12px 16px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;color:#1E40AF;font-size:13px;">Unity is currently operating in test mode. No real payment, deposit or payout was processed.</p>`
    : ''
  const testModeText = input.testModeNotice
    ? '\n\nUnity is currently operating in test mode. No real payment, deposit or payout was processed.'
    : ''

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAF8F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(input.preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${BORDER};">
        <tr><td style="padding:24px 32px;border-bottom:1px solid ${BORDER};">
          <span style="color:${BRAND_RED};font-weight:800;font-size:20px;letter-spacing:-0.02em;">UNITY</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;color:${TEXT_DARK};font-size:15px;font-weight:600;">${escapeHtml(input.greeting)}</p>
          ${paragraphsHtml}
          ${summaryHtml}
          ${ctaHtml}
          ${testModeHtml}
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid ${BORDER};background:#FAF8F5;">
          <p style="margin:0 0 8px;color:#9B8B85;font-size:12px;line-height:1.6;">
            Questions? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_RED};">${SUPPORT_EMAIL}</a>.
          </p>
          <p style="margin:0;color:#9B8B85;font-size:11px;line-height:1.6;">
            Unity — South Africa's peer-to-peer rental marketplace, currently in public test.
            <a href="${absoluteUrl('/terms')}" style="color:#9B8B85;">Terms</a> ·
            <a href="${absoluteUrl('/privacy')}" style="color:#9B8B85;">Privacy</a> ·
            <a href="${absoluteUrl('/contact')}" style="color:#9B8B85;">Contact</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = `UNITY

${input.greeting}

${paragraphsText}
${summaryText}${ctaText}${testModeText}

Questions? Contact us at ${SUPPORT_EMAIL}.

Unity — South Africa's peer-to-peer rental marketplace, currently in public test.
Terms: ${absoluteUrl('/terms')}
Privacy: ${absoluteUrl('/privacy')}
Contact: ${absoluteUrl('/contact')}`

  return { html, text }
}
