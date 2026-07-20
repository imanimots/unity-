'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import { Eye, EyeOff, Check } from 'lucide-react'
import type { UserRole } from '@/types'

const schema = z.object({
  full_name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  terms: z.boolean().refine(Boolean, 'You must accept the terms'),
})

type FormData = z.infer<typeof schema>

export default function RegisterPage() {
  const router = useRouter()
  const [role, setRole] = useState<UserRole>('renter')
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

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        data: { full_name: data.full_name, role },
      },
    })

    if (authError) {
      setError(authError.message)
      setLoading(false)
      return
    }

    if (authData.user) {
      await supabase.from('profiles').upsert({
        id: authData.user.id,
        full_name: data.full_name,
        display_name: data.full_name.split(' ')[0],
        role,
      })
    }

    router.push(role === 'merchant' ? '/dashboard/merchant' : '/')
  }

  const roles: { value: UserRole; label: string; desc: string }[] = [
    { value: 'renter',   label: 'RENTER',   desc: 'Browse and rent items' },
    { value: 'merchant', label: 'MERCHANT', desc: 'List items and earn' },
    { value: 'both',     label: 'BOTH',     desc: 'Rent and list — do it all' },
  ]

  return (
    <div className="w-full max-w-md">
      {/* Page heading */}
      <div className="mb-10 text-center">
        <h1
          className="font-extrabold uppercase tracking-tight leading-none text-[#1A0A0A] mb-3"
          style={{ fontSize: 'clamp(40px, 5.5vw, 72px)' }}
        >
          CREATE ACCOUNT.
        </h1>
        <p className="text-[#6B5B55] text-base">Join the Unity community.</p>
      </div>

      {/* Role selector */}
      <div className="mb-8">
        <p className="text-xs font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">I want to…</p>
        <div className="grid grid-cols-3 gap-3">
          {roles.map(({ value, label, desc }) => (
            <button
              key={value}
              type="button"
              onClick={() => setRole(value)}
              className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 text-center transition-all ${
                role === value
                  ? 'border-[#8B1A1A] bg-[#FAF8F5]'
                  : 'border-[#E8E0D8] bg-white hover:border-[#8B1A1A]/40'
              }`}
            >
              {role === value && (
                <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-[#8B1A1A] flex items-center justify-center">
                  <Check size={9} className="text-white" />
                </span>
              )}
              <span className="text-xs font-extrabold text-[#1A0A0A] tracking-wide">{label}</span>
              <span className="text-[10px] text-[#9B8B85] leading-tight">{desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* Full name */}
        <div>
          <label className="block text-xs font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
            Full name
          </label>
          <input
            {...register('full_name')}
            type="text"
            placeholder="Thabo Nkosi"
            className="w-full h-12 px-4 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder:text-[#C4B8B0] focus:outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/15 text-sm transition-colors"
          />
          {errors.full_name && <p className="text-xs text-[#E03D2F] mt-1.5">{errors.full_name.message}</p>}
        </div>

        {/* Email */}
        <div>
          <label className="block text-xs font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
            Email
          </label>
          <input
            {...register('email')}
            type="email"
            placeholder="thabo@email.com"
            className="w-full h-12 px-4 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder:text-[#C4B8B0] focus:outline-none focus:border-[#8B1A1A] focus:ring-2 focus:ring-[#8B1A1A]/15 text-sm transition-colors"
          />
          {errors.email && <p className="text-xs text-[#E03D2F] mt-1.5">{errors.email.message}</p>}
        </div>

        {/* Password */}
        <div>
          <label className="block text-xs font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
            Password
          </label>
          <div className="relative">
            <input
              {...register('password')}
              type={showPassword ? 'text' : 'password'}
              placeholder="At least 8 characters"
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

        {/* Terms */}
        <div className="flex items-start gap-3 pt-1">
          <input
            {...register('terms')}
            type="checkbox"
            id="terms"
            className="mt-0.5 rounded border-[#E8E0D8] accent-[#8B1A1A] shrink-0"
          />
          <label htmlFor="terms" className="text-xs text-[#6B5B55] leading-relaxed">
            I agree to Unity&apos;s{' '}
            <Link href="/terms" className="text-[#8B1A1A] hover:text-[#C4511F] underline hover:no-underline transition-colors">Terms &amp; Conditions</Link>,{' '}
            <Link href="/privacy" className="text-[#8B1A1A] hover:text-[#C4511F] underline hover:no-underline transition-colors">Privacy Policy</Link>{' '}
            and{' '}
            <Link href="/popia" className="text-[#8B1A1A] hover:text-[#C4511F] underline hover:no-underline transition-colors">POPIA Policy</Link>.
          </label>
        </div>
        {errors.terms && <p className="text-xs text-[#E03D2F] -mt-2">{errors.terms.message}</p>}

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
          className="w-full h-12 flex items-center justify-center bg-[#8B1A1A] text-white font-extrabold text-sm uppercase tracking-[0.08em] rounded-lg hover:bg-[#7A1616] transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
        >
          {loading ? 'Creating account…' : 'CREATE ACCOUNT'}
        </button>
      </form>

      {/* Login link */}
      <p className="text-center text-sm text-[#9B8B85] mt-8">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-[#8B1A1A] hover:text-[#C4511F] transition-colors">
          Sign in
        </Link>
      </p>
    </div>
  )
}
