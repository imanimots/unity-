'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import { Eye, EyeOff } from 'lucide-react'

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
})

type FormData = z.infer<typeof schema>

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = searchParams.get('redirectTo') ?? '/'
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      setError('Invalid email or password. Please try again.')
      setLoading(false)
      return
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
          SIGN IN.
        </h1>
        <p className="text-[#6B5B55] text-base">Welcome back to Unity.</p>
      </div>

      {/* Form card */}
      <div className="w-full max-w-md mx-auto">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          {/* Email */}
          <div>
            <label className="block text-xs font-500 uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
              Email
            </label>
            <input
              {...register('email')}
              type="email"
              placeholder="you@email.com"
              className="w-full h-12 px-4 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder:text-[#C4B8B0] focus:outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/15 text-sm transition-colors"
            />
            {errors.email && <p className="text-xs text-[#E03D2F] mt-1.5">{errors.email.message}</p>}
          </div>

          {/* Password */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-500 uppercase tracking-[0.15em] text-[#9B8B85]">
                Password
              </label>
              <Link href="/forgot-password" className="text-xs text-[#8B1A1A] hover:text-[#C4511F] transition-colors">
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <input
                {...register('password')}
                type={showPassword ? 'text' : 'password'}
                placeholder="Your password"
                className="w-full h-12 px-4 pr-11 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder:text-[#C4B8B0] focus:outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/15 text-sm transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9B8B85] hover:text-[#6B5B55] transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.password && <p className="text-xs text-[#E03D2F] mt-1.5">{errors.password.message}</p>}
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
            {loading ? 'Signing in…' : 'SIGN IN'}
          </button>
        </form>

        {/* Register link */}
        <p className="text-center text-sm text-[#9B8B85] mt-8">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="font-semibold text-[#8B1A1A] hover:text-[#C4511F] transition-colors">
            Create one
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
