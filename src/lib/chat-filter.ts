const RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(\+27|0)[6-8]\d{8}/, reason: 'Phone number detected' },
  { pattern: /\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/, reason: 'Phone number detected' },
  { pattern: /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i, reason: 'Email address detected' },
  { pattern: /\b(eft|bank transfer|account number|banking details|pay me directly|send money|my bank|fnb|nedbank|absa|capitec|standard bank|account no|acc no|direct payment|outside unity|paypal|cash app)\b/i, reason: 'Off-platform payment request' },
  { pattern: /\b(whatsapp me|text me|call me|my number is|reach me at|contact me on|find me on)\b/i, reason: 'Off-platform contact request' },
]

export function filterMessage(content: string): { blocked: boolean; reason: string | null } {
  for (const rule of RULES) {
    if (rule.pattern.test(content)) {
      return { blocked: true, reason: rule.reason }
    }
  }
  return { blocked: false, reason: null }
}
