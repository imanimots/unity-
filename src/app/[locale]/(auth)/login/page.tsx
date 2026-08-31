'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import { Eye, EyeOff } from 'lucide-react'
import { hasUnmergedAnonymousHistory, buildAnonymousViewRecords, markAnonymousHistoryMerged } from '@/lib/personalization/anonymous'

function LoginForm() {
  const t = useTranslations('auth.login')
  // Deliberately next/navigation's plain useRouter, not the locale-aware
  // one: redirectTo already arrives fully locale-prefixed when relevant
  // (src/lib/supabase/proxy.ts constructs it from the original request's
  // raw pathname, e.g. "/af/dashboard"). Routing an already-prefixed path
  // back through next-intl's router would treat "/af" as an ordinary path
  // segment and prepend the current locale a second time
  // ("/af/af/dashboard"). This must navigate verbatim.
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = searchParams.get('redirectTo') ?? '/'
  const passwordReset = searchParams.get('passwordReset') === '1'
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const schema = z.object({
    email: z.string().email(t('errors.enterValidEmail')),
    password: z.string().min(1, t('errors.enterPassword')),
  })
  type FormData = z.infer<typeof schema>

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  const onSubmit = async (data: FormData) => {
    setLoading(true)
    setError(null)
    const supabase = createClient()

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    })

    if (authError) {
      setError(t('errors.invalidCredentials'))
      setLoading(false)
      return
    }

    // Section 40/41: merge the anonymous browser's local view buffer into
    // the just-authenticated account, exactly once per sign-in in this
    // browser. Best-effort -- never blocks navigation, and the server
    // route itself no-ops safely if personalization is disabled or
    // unprovisioned.
    if (hasUnmergedAnonymousHistory()) {
      try {
        const events = buildAnonymousViewRecords().map((v) => ({
          entityType: v.entityType,
          entityId: v.entityId,
          mode: v.mode,
          category: v.category,
          kind: v.kind,
          province: v.province,
          city: v.city,
        }))
        await fetch('/api/personalization/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events }),
        })
      } catch {
        // Never block sign-in on this.
      } finally {
        markAnonymousHistoryMerged()
      }
    }

    router.push(redirectTo)
    router.refresh()
  }

  return (
    <div className="w-full max-w-md">
      {/* Page heading */}
      <div className="mb-10 text-center">
        <h1
          className="font-extrabold uppercase tracking-tight leading-none text-[#1A0A0A] mb-3"
          style={{ fontSize: 'clamp(48px, 6vw, 80px)' }}
        >
          {t('heading')}
        </h1>
        <p className="text-[#6B5B55] text-base">{t('subheading')}</p>
      </div>

      {/* Form card */}
      <div className="w-full max-w-md mx-auto">
        {passwordReset && (
          <div className="mb-5 border border-[#2F7D4F]/25 bg-[#2F7D4F]/5 rounded-lg px-4 py-3 text-sm text-[#2F7D4F]">
            {t('passwordResetSuccess')}
          </div>
        )}
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          {/* Email */}
          <div>
            <label htmlFor="login-email" className="block text-xs font-500 uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
              {t('emailLabel')}
            </label>
            <input
              {...register('email')}
              id="login-email"
              type="email"
              placeholder="you@email.com"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
              className="w-full h-12 px-4 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder:text-[#C4B8B0] focus:outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/15 text-sm transition-colors"
            />
            {errors.email && <p id="login-email-error" className="text-xs text-[#E03D2F] mt-1.5">{errors.email.message}</p>}
          </div>

          {/* Password */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="login-password" className="block text-xs font-500 uppercase tracking-[0.15em] text-[#9B8B85]">
                {t('passwordLabel')}
              </label>
              <Link href="/forgot-password" className="text-xs text-[#8B1A1A] hover:text-[#C4511F] transition-colors">
                {t('forgotPassword')}
              </Link>
            </div>
            <div className="relative">
              <input
                {...register('password')}
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Your password"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'login-password-error' : undefined}
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
            {errors.password && <p id="login-password-error" className="text-xs text-[#E03D2F] mt-1.5">{errors.password.message}</p>}
          </div>

          {/* Error */}
          {error && (
            <div className="border border-[#E03D2F]/25 bg-[#E03D2F]/5 rounded-lg px-4 py-3 text-sm text-[#E03D2F]">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 flex items-center justify-center bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-50 mt-2"
          >
            {loading ? t('signingIn') : t('submit')}
          </button>
        </form>

        {/* Register link */}
        <p className="text-center text-sm text-[#9B8B85] mt-8">
          {t('noAccount')}{' '}
          <Link href="/register" className="font-semibold text-[#8B1A1A] hover:text-[#C4511F] transition-colors">
            {t('createOne')}
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full max-w-md">
          <div className="h-20 bg-[#F2EDE8] rounded-xl animate-pulse mb-10" />
          <div className="space-y-4">
            <div className="h-12 bg-[#F2EDE8] rounded-lg animate-pulse" />
            <div className="h-12 bg-[#F2EDE8] rounded-lg animate-pulse" />
            <div className="h-12 bg-[#F2EDE8] rounded-lg animate-pulse" />
          </div>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  )
}
