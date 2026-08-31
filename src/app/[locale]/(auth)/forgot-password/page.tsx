'use client'

import { useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { CheckCircle2 } from 'lucide-react'

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgotPassword')
  const locale = useLocale()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const schema = z.object({
    email: z.string().email(t('errors.enterValidEmail')),
  })
  type FormData = z.infer<typeof schema>

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  const onSubmit = async (data: FormData) => {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email, locale }),
      })

      if (res.status === 429) {
        setError(t('errors.tooManyRequests'))
        setLoading(false)
        return
      }
      if (!res.ok) {
        setError(t('errors.generic'))
        setLoading(false)
        return
      }

      // Generic confirmation regardless of account existence -- see
      // src/app/api/auth/forgot-password/route.ts.
      setSent(true)
      setLoading(false)
    } catch {
      setError(t('errors.generic'))
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="w-full max-w-md text-center">
        <CheckCircle2 className="mx-auto mb-5 text-[#8B1A1A]" size={40} />
        <h1 className="font-extrabold uppercase tracking-tight leading-none text-[#1A0A0A] mb-3 text-3xl">{t('heading')}</h1>
        <p className="text-[#6B5B55] text-base mb-8">{t('genericConfirmation')}</p>
        <Link href="/login" className="font-semibold text-[#8B1A1A] hover:text-[#C4511F] transition-colors text-sm">
          {t('backToLogin')}
        </Link>
      </div>
    )
  }

  return (
    <div className="w-full max-w-md">
      <div className="mb-10 text-center">
        <h1
          className="font-extrabold uppercase tracking-tight leading-none text-[#1A0A0A] mb-3"
          style={{ fontSize: 'clamp(40px, 5vw, 64px)' }}
        >
          {t('heading')}
        </h1>
        <p className="text-[#6B5B55] text-base">{t('subheading')}</p>
      </div>

      <div className="w-full max-w-md mx-auto">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          <div>
            <label htmlFor="forgot-password-email" className="block text-xs font-500 uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
              {t('emailLabel')}
            </label>
            <input
              {...register('email')}
              id="forgot-password-email"
              type="email"
              placeholder="you@email.com"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'forgot-password-email-error' : undefined}
              className="w-full h-12 px-4 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder:text-[#C4B8B0] focus:outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/15 text-sm transition-colors"
            />
            {errors.email && <p id="forgot-password-email-error" className="text-xs text-[#E03D2F] mt-1.5">{errors.email.message}</p>}
          </div>

          {error && (
            <div className="border border-[#E03D2F]/25 bg-[#E03D2F]/5 rounded-lg px-4 py-3 text-sm text-[#E03D2F]">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 flex items-center justify-center bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-50 mt-2"
          >
            {loading ? t('sending') : t('submit')}
          </button>
        </form>

        <p className="text-center text-sm text-[#9B8B85] mt-8">
          <Link href="/login" className="font-semibold text-[#8B1A1A] hover:text-[#C4511F] transition-colors">
            {t('backToLogin')}
          </Link>
        </p>
      </div>
    </div>
  )
}
