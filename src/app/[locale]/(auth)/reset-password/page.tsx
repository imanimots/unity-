'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import { Eye, EyeOff, AlertTriangle } from 'lucide-react'

type Status = 'exchanging' | 'ready' | 'invalid' | 'success'

function ResetPasswordForm() {
  const t = useTranslations('auth.resetPassword')
  const router = useRouter()

  const [status, setStatus] = useState<Status>('exchanging')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const processed = useRef(false)

  // This project's Supabase Auth is configured for the implicit/hash
  // recovery flow, not PKCE: the email link redirects here carrying
  // `#access_token=...&refresh_token=...&type=recovery` (confirmed live
  // -- a reused/expired link instead carries `#error=access_denied&
  // error_code=otp_expired`). The hash fragment is never sent to the
  // server, so it can only be read/consumed client-side. Establishing
  // the session via setSession() with these exact tokens -- rather than
  // trusting any application-supplied email/user id -- is the actual
  // security gate: updateUser() below only ever runs against a session
  // Supabase itself just issued from a genuine, single-use recovery
  // link, never against a bare identifier the caller provides.
  useEffect(() => {
    if (processed.current) return
    processed.current = true

    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const params = new URLSearchParams(hash)
    // Strip the hash immediately -- these are single-use, sensitive
    // values and shouldn't linger in the address bar/history regardless
    // of outcome.
    window.history.replaceState(null, '', window.location.pathname)

    // One-time initial classification of this page load, not a reactive
    // loop -- matches the identical precedent in
    // src/components/messaging/chat-thread.tsx.
    if (params.get('error')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('invalid')
      return
    }

    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')
    if (params.get('type') !== 'recovery' || !accessToken || !refreshToken) {
      setStatus('invalid')
      return
    }

    const supabase = createClient()
    supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ error: sessionError }) => {
      setStatus(sessionError ? 'invalid' : 'ready')
    })
  }, [])

  const schema = z
    .object({
      password: z.string().min(8, t('errors.passwordTooShort')),
      confirmPassword: z.string().min(1, t('errors.passwordsDontMatch')),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: t('errors.passwordsDontMatch'),
      path: ['confirmPassword'],
    })
  type FormData = z.infer<typeof schema>

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  const onSubmit = async (data: FormData) => {
    setSubmitting(true)
    setError(null)
    const supabase = createClient()

    const { error: updateError } = await supabase.auth.updateUser({ password: data.password })
    if (updateError) {
      setError(t('errors.generic'))
      setSubmitting(false)
      return
    }

    // The recovery session should not silently become an ordinary signed-in
    // product session -- sign out and send the user back to login to
    // consciously re-authenticate with the new password.
    await supabase.auth.signOut()
    setStatus('success')
    setTimeout(() => router.push('/login?passwordReset=1'), 1500)
  }

  if (status === 'exchanging') {
    return (
      <div className="w-full max-w-md">
        <div className="h-20 bg-[#F2EDE8] rounded-xl animate-pulse mb-10" />
        <div className="h-12 bg-[#F2EDE8] rounded-lg animate-pulse" />
      </div>
    )
  }

  if (status === 'invalid') {
    return (
      <div className="w-full max-w-md text-center">
        <AlertTriangle className="mx-auto mb-5 text-[#E03D2F]" size={40} />
        <h1 className="font-extrabold uppercase tracking-tight leading-none text-[#1A0A0A] mb-3 text-3xl">{t('invalidTitle')}</h1>
        <p className="text-[#6B5B55] text-base mb-8">{t('invalidMessage')}</p>
        <Link href="/forgot-password" className="font-semibold text-[#8B1A1A] hover:text-[#C4511F] transition-colors text-sm">
          {t('requestNewLink')}
        </Link>
      </div>
    )
  }

  if (status === 'success') {
    return (
      <div className="w-full max-w-md text-center">
        <h1 className="font-extrabold uppercase tracking-tight leading-none text-[#1A0A0A] mb-3 text-3xl">{t('successTitle')}</h1>
        <p className="text-[#6B5B55] text-base">{t('successMessage')}</p>
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
            <label htmlFor="reset-password-password" className="block text-xs font-500 uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
              {t('passwordLabel')}
            </label>
            <div className="relative">
              <input
                {...register('password')}
                id="reset-password-password"
                type={showPassword ? 'text' : 'password'}
                placeholder={t('passwordPlaceholder')}
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'reset-password-password-error' : undefined}
                className="w-full h-12 px-4 pr-11 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder:text-[#C4B8B0] focus:outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/15 text-sm transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9B8B85] hover:text-[#6B5B55] transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.password && <p id="reset-password-password-error" className="text-xs text-[#E03D2F] mt-1.5">{errors.password.message}</p>}
          </div>

          <div>
            <label htmlFor="reset-password-confirm" className="block text-xs font-500 uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
              {t('confirmPasswordLabel')}
            </label>
            <input
              {...register('confirmPassword')}
              id="reset-password-confirm"
              type={showPassword ? 'text' : 'password'}
              placeholder={t('passwordPlaceholder')}
              aria-invalid={!!errors.confirmPassword}
              aria-describedby={errors.confirmPassword ? 'reset-password-confirm-error' : undefined}
              className="w-full h-12 px-4 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder:text-[#C4B8B0] focus:outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/15 text-sm transition-colors"
            />
            {errors.confirmPassword && <p id="reset-password-confirm-error" className="text-xs text-[#E03D2F] mt-1.5">{errors.confirmPassword.message}</p>}
          </div>

          {error && (
            <div className="border border-[#E03D2F]/25 bg-[#E03D2F]/5 rounded-lg px-4 py-3 text-sm text-[#E03D2F]">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-12 flex items-center justify-center bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-50 mt-2"
          >
            {submitting ? t('updating') : t('submit')}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full max-w-md">
          <div className="h-20 bg-[#F2EDE8] rounded-xl animate-pulse mb-10" />
          <div className="h-12 bg-[#F2EDE8] rounded-lg animate-pulse" />
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  )
}
