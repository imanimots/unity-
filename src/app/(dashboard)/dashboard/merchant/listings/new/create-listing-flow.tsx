'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import {
  ChevronLeft, ChevronRight, Check, Upload, X, ImagePlus,
  FileText, AlertCircle, ShieldCheck, Info, Star, UserCheck,
} from 'lucide-react'
import { CATEGORIES, type ItemCondition, type ShippingPayer } from '@/types'
import { calculateRiskTier, getRiskRequirements, RISK_TIER_LABELS } from '@/lib/risk/engine'
import { useAuth } from '@/hooks/use-auth'

// ─── Step definitions ────────────────────────────────────────────────────────

const STEPS = [
  { id: 'basics',       title: 'Basics',       desc: 'Title, category & condition' },
  { id: 'photos',       title: 'Photos',       desc: 'At least 3 item photos' },
  { id: 'ownership',    title: 'Ownership',    desc: 'Proof of ownership' },
  { id: 'pricing',      title: 'Pricing',      desc: 'Rates, insurance & shipping' },
  { id: 'requirements', title: 'Requirements', desc: 'Deposit & renter criteria' },
  { id: 'affiliates',   title: 'Affiliates',   desc: 'Referral program' },
  { id: 'review',       title: 'Review',       desc: 'Confirm & publish' },
] as const

type StepId = typeof STEPS[number]['id']

// ─── Zod schemas per step ────────────────────────────────────────────────────

const basicsSchema = z.object({
  title:       z.string().min(10, 'Title must be at least 10 characters'),
  category:    z.string().min(1, 'Please select a category'),
  condition:   z.enum(['new', 'like_new', 'good', 'fair'] as const, { error: 'Please select a condition' }),
  description: z.string().min(50, 'Description must be at least 50 characters'),
})

const pricingSchema = z.object({
  daily_rate:       z.number({ error: 'Required' }).min(10, 'Minimum rate is R10/day'),
  weekly_rate:      z.number().optional(),
  min_rental_days:  z.number().min(1).max(30),
  shipping_payer:   z.enum(['renter', 'merchant', 'split', 'negotiate'] as const),
  insurance_amount: z.number().optional(),
})

const requirementsSchema = z.object({
  min_unity_score:  z.number().min(0).max(5),
  deposit_required: z.boolean(),
  deposit_amount:   z.number().optional(),
})

const affiliatesSchema = z.object({
  accepts_affiliates:        z.boolean(),
  affiliate_commission_rate: z.number().min(1).max(50).optional(),
})

type BasicsData       = z.infer<typeof basicsSchema>
type PricingData      = z.infer<typeof pricingSchema>
type RequirementsData = z.infer<typeof requirementsSchema>
type AffiliatesData   = z.infer<typeof affiliatesSchema>

// ─── Helper components ───────────────────────────────────────────────────────

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <p className="flex items-center gap-1 text-xs text-[#E03D2F] mt-1">
      <AlertCircle size={11} /> {message}
    </p>
  )
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1.5">
      {children}{required && <span className="text-[#E03D2F] ml-0.5">*</span>}
    </label>
  )
}

function inputCls(hasError?: boolean) {
  return `w-full px-3.5 py-2.5 rounded-xl border text-sm bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 transition-colors ${
    hasError
      ? 'border-[#E03D2F]/50 dark:border-[#E03D2F]/40 focus:border-[#E03D2F] focus:ring-[#E03D2F]/20'
      : 'border-[#F2EDE8] dark:border-[#2A1A1A] focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20'
  }`
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <div className="w-11 h-6 bg-[#F2EDE8] dark:bg-[#2A1A1A] rounded-full peer peer-checked:bg-[#8B1A1A] transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
    </label>
  )
}

// ─── Step: Basics ─────────────────────────────────────────────────────────────

function BasicsStep({ onNext, defaults }: { onNext: (d: BasicsData) => void; defaults?: Partial<BasicsData> }) {
  const { register, handleSubmit, watch, formState: { errors } } = useForm<BasicsData>({
    resolver: zodResolver(basicsSchema),
    defaultValues: defaults,
  })
  const description = watch('description') ?? ''

  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-5">
      <div>
        <Label required>Item title</Label>
        <input {...register('title')} placeholder="e.g. DJI Mavic 3 Pro Drone + ND Filters" className={inputCls(!!errors.title)} />
        <FieldError message={errors.title?.message} />
      </div>

      <div>
        <Label required>Category</Label>
        <select {...register('category')} className={inputCls(!!errors.category)}>
          <option value="">Select a category…</option>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
          ))}
        </select>
        <FieldError message={errors.category?.message} />
      </div>

      <div>
        <Label required>Condition</Label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(['new', 'like_new', 'good', 'fair'] as ItemCondition[]).map((cond) => {
            const labels: Record<string, string> = { new: '🆕 New', like_new: '✨ Like new', good: '👍 Good', fair: '👌 Fair' }
            return (
              <label key={cond} className="cursor-pointer">
                <input type="radio" value={cond} {...register('condition')} className="sr-only peer" />
                <div className="text-center py-2.5 px-2 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm font-medium text-[#6B5B55] dark:text-[#9B8B85] peer-checked:border-[#8B1A1A] peer-checked:bg-[#8B1A1A] peer-checked:text-white transition-colors hover:border-[#8B1A1A]/50">
                  {labels[cond]}
                </div>
              </label>
            )
          })}
        </div>
        <FieldError message={errors.condition?.message} />
      </div>

      <div>
        <Label required>Description</Label>
        <textarea
          {...register('description')}
          rows={5}
          placeholder="Describe your item — what's included, its condition, any accessories, and anything a renter should know…"
          className={inputCls(!!errors.description)}
        />
        <div className="flex items-center justify-between mt-1">
          <FieldError message={errors.description?.message} />
          <span className={`text-xs ml-auto ${description.length < 50 ? 'text-[#F2EDE8] dark:text-[#2A1A1A]' : 'text-[#9B8B85]'}`}>
            {description.length} / 50+ chars
          </span>
        </div>
      </div>

      <button type="submit" className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
        Continue <ChevronRight size={16} />
      </button>
    </form>
  )
}

// ─── Step: Photos ─────────────────────────────────────────────────────────────

function PhotosStep({
  onNext, onBack, photos, setPhotos,
}: {
  onNext: () => void
  onBack: () => void
  photos: File[]
  setPhotos: (f: File[]) => void
}) {
  const [previews, setPreviews] = useState<string[]>(() => photos.map((f) => URL.createObjectURL(f)))
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return
    const valid = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const newPreviews = valid.map((f) => URL.createObjectURL(f))
    setPhotos([...photos, ...valid])
    setPreviews((p) => [...p, ...newPreviews])
    setError('')
  }, [photos, setPhotos])

  const remove = (i: number) => {
    URL.revokeObjectURL(previews[i])
    setPhotos(photos.filter((_, idx) => idx !== i))
    setPreviews((p) => p.filter((_, idx) => idx !== i))
  }

  const handleNext = () => {
    if (photos.length < 3) { setError('Please upload at least 3 photos'); return }
    onNext()
  }

  return (
    <div className="space-y-5">
      <div>
        <Label required>Item photos (minimum 3)</Label>
        <p className="text-xs text-[#9B8B85] mb-3">Upload clear photos from different angles. The first photo will be the cover image.</p>

        <div
          className="border-2 border-dashed border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-8 text-center cursor-pointer hover:border-[#8B1A1A] dark:hover:border-[#8B1A1A] transition-colors"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
        >
          <ImagePlus size={28} className="mx-auto text-[#9B8B85] mb-2" />
          <p className="text-sm font-medium text-[#6B5B55] dark:text-[#9B8B85]">Click to upload or drag & drop</p>
          <p className="text-xs text-[#9B8B85] mt-1">JPG, PNG, WEBP — up to 10MB each</p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>

        {error && <p className="flex items-center gap-1 text-xs text-[#E03D2F] mt-2"><AlertCircle size={11} />{error}</p>}
      </div>

      {previews.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {previews.map((src, i) => (
            <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-[#FAF8F5] dark:bg-[#1A1010] group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
              {i === 0 && (
                <span className="absolute bottom-1 left-1 text-[10px] font-bold bg-[#1A0A0A]/80 text-white px-1.5 py-0.5 rounded-full">Cover</span>
              )}
              <button
                onClick={() => remove(i)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-[#1A0A0A]/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[#E03D2F]"
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button
            onClick={() => inputRef.current?.click()}
            className="aspect-square rounded-xl border-2 border-dashed border-[#F2EDE8] dark:border-[#2A1A1A] flex flex-col items-center justify-center text-[#9B8B85] hover:border-[#8B1A1A] transition-colors text-xs gap-1"
          >
            <Plus size={18} />
            Add more
          </button>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> Back
        </button>
        <button onClick={handleNext} className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          Continue <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

// ─── Step: Ownership proof ────────────────────────────────────────────────────

function OwnershipStep({
  onNext, onBack, ownershipFile, setOwnershipFile,
}: {
  onNext: () => void
  onBack: () => void
  ownershipFile: File | null
  setOwnershipFile: (f: File | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')

  const handleNext = () => {
    if (!ownershipFile) { setError('Please upload proof of ownership'); return }
    onNext()
  }

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-4 flex gap-3">
        <Info size={16} className="text-blue-500 shrink-0 mt-0.5" />
        <div className="text-sm text-blue-700 dark:text-blue-300">
          <p className="font-medium mb-1">Why do we need this?</p>
          <p className="text-xs leading-relaxed text-blue-600 dark:text-blue-400">
            Ownership proof protects both you and renters. It&apos;s reviewed by Unity within 24 hours.
            Accepted: purchase receipt, serial number photo, warranty card, or short video of the item.
          </p>
        </div>
      </div>

      <div>
        <Label required>Proof of ownership</Label>
        {ownershipFile ? (
          <div className="flex items-center gap-3 p-4 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded-xl">
            <FileText size={20} className="text-green-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-green-700 dark:text-green-400 truncate">{ownershipFile.name}</p>
              <p className="text-xs text-green-600 dark:text-green-500">{(ownershipFile.size / 1024 / 1024).toFixed(1)} MB</p>
            </div>
            <button onClick={() => setOwnershipFile(null)} className="p-1.5 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 text-green-600 dark:text-green-400 transition-colors">
              <X size={14} />
            </button>
          </div>
        ) : (
          <div
            className="border-2 border-dashed border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-8 text-center cursor-pointer hover:border-[#8B1A1A] dark:hover:border-[#8B1A1A] transition-colors"
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={28} className="mx-auto text-[#9B8B85] mb-2" />
            <p className="text-sm font-medium text-[#6B5B55] dark:text-[#9B8B85]">Click to upload</p>
            <p className="text-xs text-[#9B8B85] mt-1">JPG, PNG, PDF, MP4 — up to 50MB</p>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,application/pdf,video/mp4"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) { setOwnershipFile(f); setError('') }
              }}
            />
          </div>
        )}
        {error && <p className="flex items-center gap-1 text-xs text-[#E03D2F] mt-2"><AlertCircle size={11} />{error}</p>}
      </div>

      <div className="flex gap-3 pt-2">
        <button onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> Back
        </button>
        <button onClick={handleNext} className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          Continue <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

// ─── Step: Pricing ────────────────────────────────────────────────────────────

function PricingStep({ onNext, onBack, defaults }: { onNext: (d: PricingData) => void; onBack: () => void; defaults?: Partial<PricingData> }) {
  const { register, handleSubmit, formState: { errors } } = useForm<PricingData>({
    resolver: zodResolver(pricingSchema),
    defaultValues: { min_rental_days: 1, shipping_payer: 'renter', ...defaults },
  })

  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required>Daily rate (R)</Label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
            <input type="number" min={10} {...register('daily_rate', { valueAsNumber: true })} placeholder="0" className={`${inputCls(!!errors.daily_rate)} pl-8`} />
          </div>
          <FieldError message={errors.daily_rate?.message} />
        </div>

        <div>
          <Label>Weekly rate (R) <span className="text-[#9B8B85] font-normal text-xs">(optional)</span></Label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
            <input type="number" min={0} {...register('weekly_rate', { valueAsNumber: true })} placeholder="0" className={`${inputCls(!!errors.weekly_rate)} pl-8`} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required>Minimum rental (days)</Label>
          <input type="number" min={1} max={30} {...register('min_rental_days', { valueAsNumber: true })} className={inputCls(!!errors.min_rental_days)} />
          <FieldError message={errors.min_rental_days?.message} />
        </div>

        <div>
          <Label>Insurance per day (R) <span className="text-[#9B8B85] font-normal text-xs">(optional)</span></Label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
            <input type="number" min={0} {...register('insurance_amount', { valueAsNumber: true })} placeholder="0" className={`${inputCls()} pl-8`} />
          </div>
          <p className="text-xs text-[#9B8B85] mt-1">Charged to the renter per day. Leave blank to skip.</p>
        </div>
      </div>

      <div>
        <Label required>Who pays shipping?</Label>
        <div className="grid grid-cols-2 gap-2">
          {([
            ['renter',    '🧑 Renter pays'],
            ['merchant',  '🏪 I cover it (free shipping)'],
            ['split',     '🤝 Split 50/50'],
            ['negotiate', '💬 Negotiate with renter'],
          ] as [ShippingPayer, string][]).map(([val, label]) => (
            <label key={val} className="cursor-pointer">
              <input type="radio" value={val} {...register('shipping_payer')} className="sr-only peer" />
              <div className="py-2.5 px-3 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm text-[#6B5B55] dark:text-[#9B8B85] peer-checked:border-[#8B1A1A] peer-checked:bg-[#8B1A1A] peer-checked:text-white transition-colors hover:border-[#8B1A1A]/50 text-center">
                {label}
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> Back
        </button>
        <button type="submit" className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          Continue <ChevronRight size={16} />
        </button>
      </div>
    </form>
  )
}

// ─── Step: Renter Requirements ────────────────────────────────────────────────

function RequirementsStep({
  onNext, onBack, defaults, category, dailyRate,
}: {
  onNext: (d: RequirementsData) => void
  onBack: () => void
  defaults?: Partial<RequirementsData>
  category?: string
  dailyRate?: number
}) {
  const { profile } = useAuth()
  const { register, handleSubmit, watch, setValue } = useForm<RequirementsData>({
    resolver: zodResolver(requirementsSchema),
    defaultValues: { min_unity_score: 0, deposit_required: false, ...defaults },
  })
  const depositRequired = watch('deposit_required')

  const riskTier = calculateRiskTier({
    category: category ?? '',
    dailyRate: dailyRate ?? 0,
    merchantKycStatus: profile?.kyc_status ?? 'none',
    merchantUnityScore: profile?.unity_score ?? 0,
  })
  const riskRequirements = getRiskRequirements(riskTier)

  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-5">
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-xl p-4 flex gap-3">
        <Info size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          Set the minimum bar for renters. If a renter doesn&apos;t meet your requirements, they&apos;ll see a clear message explaining why before they can book.
        </p>
      </div>

      {/* Unity Score */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Star size={16} className="text-amber-400 fill-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Minimum Unity Score</p>
            <p className="text-xs text-[#9B8B85] mt-0.5">Only renters with this score or above can book</p>
          </div>
        </div>
        <select {...register('min_unity_score', { valueAsNumber: true })} className={inputCls()}>
          <option value={0}>No minimum</option>
          <option value={3.0}>3.0+ (Good standing)</option>
          <option value={3.5}>3.5+ (Trusted)</option>
          <option value={4.0}>4.0+ (Highly trusted)</option>
          <option value={4.5}>4.5+ (Elite)</option>
        </select>
      </div>

      {/* Security deposit */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <ShieldCheck size={16} className="text-[#9B8B85] shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Security deposit</p>
              <p className="text-xs text-[#9B8B85] mt-0.5">Held in escrow and returned when item comes back undamaged</p>
            </div>
          </div>
          <Toggle checked={depositRequired} onChange={(v) => setValue('deposit_required', v)} />
        </div>
        {depositRequired && (
          <div>
            <Label required>Deposit amount (R)</Label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
              <input type="number" min={0} {...register('deposit_amount', { valueAsNumber: true })} placeholder="0" className={`${inputCls()} pl-8`} />
            </div>
          </div>
        )}
      </div>

      {/* Risk tier — automatic, not merchant-configurable */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4">
        <div className="flex items-start gap-3">
          <UserCheck size={16} className="text-[#9B8B85] shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
              Risk tier: {RISK_TIER_LABELS[riskTier]}
            </p>
            <p className="text-xs text-[#9B8B85] mt-0.5">
              Assigned automatically by Unity&apos;s Risk Engine from category, price, and your merchant standing —
              this can&apos;t be changed manually.
            </p>
            <ul className="mt-3 space-y-1 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
              {riskRequirements.ownershipVerificationRequired && <li>• Ownership verification required</li>}
              {riskRequirements.inspectionVideoRequired && <li>• Inspection video required</li>}
              {riskRequirements.depositRequired && <li>• Deposit mandatory before publishing</li>}
              {!riskRequirements.depositRequired && riskRequirements.depositRecommended && (
                <li>• Deposit recommended</li>
              )}
              {riskRequirements.insuranceRequired && <li>• Insurance mandatory before publishing</li>}
              {riskRequirements.manualReviewRequired && <li>• Requires manual review by Unity before going live</li>}
              {riskTier === 'low' && <li>• No deposit or ownership verification required</li>}
            </ul>
          </div>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> Back
        </button>
        <button type="submit" className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          Continue <ChevronRight size={16} />
        </button>
      </div>
    </form>
  )
}

// ─── Step: Affiliates ─────────────────────────────────────────────────────────

function AffiliatesStep({ onNext, onBack, defaults }: { onNext: (d: AffiliatesData) => void; onBack: () => void; defaults?: Partial<AffiliatesData> }) {
  const { register, handleSubmit, watch } = useForm<AffiliatesData>({
    resolver: zodResolver(affiliatesSchema),
    defaultValues: { accepts_affiliates: false, ...defaults },
  })
  const acceptsAffiliates = watch('accepts_affiliates')

  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-5">
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-xl p-4 flex gap-3">
        <Info size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          When affiliates are enabled, other Unity members can share your listing with a referral link. You pay them a commission only on completed rentals — no upfront cost.
        </p>
      </div>

      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Accept affiliates</p>
            <p className="text-xs text-[#9B8B85] mt-0.5">Allow others to refer renters to this listing</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" {...register('accepts_affiliates')} className="sr-only peer" />
            <div className="w-11 h-6 bg-[#F2EDE8] dark:bg-[#2A1A1A] rounded-full peer peer-checked:bg-[#8B1A1A] transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
          </label>
        </div>

        {acceptsAffiliates && (
          <div>
            <Label required>Commission rate (%)</Label>
            <div className="relative">
              <input
                type="number"
                min={1}
                max={50}
                {...register('affiliate_commission_rate', { valueAsNumber: true })}
                placeholder="e.g. 10"
                className={`${inputCls()} pr-8`}
              />
              <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">%</span>
            </div>
            <p className="text-xs text-[#9B8B85] mt-1">1–50%. Commission is deducted from your rental fee after the booking is completed.</p>
          </div>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> Back
        </button>
        <button type="submit" className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          Review listing <ChevronRight size={16} />
        </button>
      </div>
    </form>
  )
}

// ─── Step: Review & Publish ───────────────────────────────────────────────────

function ReviewStep({
  onBack, onPublish, publishing,
  basics, pricing, requirements, affiliates, photoCount, ownershipFileName,
}: {
  onBack: () => void
  onPublish: () => void
  publishing: boolean
  basics?: BasicsData
  pricing?: PricingData
  requirements?: RequirementsData
  affiliates?: AffiliatesData
  photoCount: number
  ownershipFileName: string
}) {
  const { profile } = useAuth()
  const riskTier = calculateRiskTier({
    category: basics?.category ?? '',
    dailyRate: pricing?.daily_rate ?? 0,
    merchantKycStatus: profile?.kyc_status ?? 'none',
    merchantUnityScore: profile?.unity_score ?? 0,
  })

  const rows: [string, string][] = [
    ['Title',        basics?.title ?? '—'],
    ['Category',     CATEGORIES.find((c) => c.id === basics?.category)?.label ?? '—'],
    ['Condition',    basics?.condition ? { new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair' }[basics.condition] : '—'],
    ['Daily rate',   pricing?.daily_rate ? `R${pricing.daily_rate}` : '—'],
    ['Weekly rate',  pricing?.weekly_rate ? `R${pricing.weekly_rate}` : 'Not set'],
    ['Min days',     pricing?.min_rental_days ? `${pricing.min_rental_days} day(s)` : '—'],
    ['Insurance',    pricing?.insurance_amount ? `R${pricing.insurance_amount}/day` : 'None'],
    ['Shipping',     pricing?.shipping_payer ? { renter: 'Renter pays', merchant: 'Free (merchant)', split: 'Split 50/50', negotiate: 'Negotiate' }[pricing.shipping_payer] : '—'],
    ['Min Unity Score', requirements?.min_unity_score ? `${requirements.min_unity_score}+` : 'No minimum'],
    ['Deposit',      requirements?.deposit_required ? `R${requirements.deposit_amount ?? 0}` : 'None'],
    ['Risk tier',    RISK_TIER_LABELS[riskTier]],
    ['Affiliates',   affiliates?.accepts_affiliates ? `Yes — ${affiliates.affiliate_commission_rate ?? 0}% commission` : 'No'],
    ['Photos',       `${photoCount} uploaded`],
    ['Ownership',    ownershipFileName || '—'],
  ]

  return (
    <div className="space-y-5">
      <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 flex gap-3">
        <ShieldCheck size={16} className="text-green-500 shrink-0 mt-0.5" />
        <p className="text-sm text-green-700 dark:text-green-400">
          Your listing will go <strong>live immediately</strong> since your KYC is verified. Ownership proof will be reviewed within 24 hours.
        </p>
      </div>

      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A] overflow-hidden">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between px-4 py-3 text-sm border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0">
            <span className="text-[#6B5B55] dark:text-[#9B8B85]">{label}</span>
            <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED] text-right max-w-[55%] truncate">{value}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-3 pt-2">
        <button onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> Back
        </button>
        <button
          onClick={onPublish}
          disabled={publishing}
          className="flex-2 flex-grow py-3 bg-[#8B1A1A] hover:bg-[#7A1616] disabled:opacity-60 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          {publishing ? (
            <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Publishing…</>
          ) : (
            <><Check size={16} /> Publish listing</>
          )}
        </button>
      </div>
    </div>
  )
}

// ─── Plus icon ────────────────────────────────────────────────────────────────

function Plus({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export function CreateListingFlow() {
  const router = useRouter()
  const [stepIdx, setStepIdx] = useState(0)
  const [publishing, setPublishing] = useState(false)

  const [basics,       setBasics]       = useState<BasicsData>()
  const [pricing,      setPricing]      = useState<PricingData>()
  const [requirements, setRequirements] = useState<RequirementsData>()
  const [affiliates,   setAffiliates]   = useState<AffiliatesData>()
  const [photos,       setPhotos]       = useState<File[]>([])
  const [ownershipFile, setOwnershipFile] = useState<File | null>(null)

  const currentStep = STEPS[stepIdx]

  const goNext = () => setStepIdx((i) => Math.min(i + 1, STEPS.length - 1))
  const goBack = () => setStepIdx((i) => Math.max(i - 1, 0))

  const handlePublish = async () => {
    setPublishing(true)
    await new Promise((r) => setTimeout(r, 1500))
    toast.success('Listing published! It\'s now live on Unity.')
    router.push('/dashboard/merchant/listings')
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">Create a listing</h1>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">
          Step {stepIdx + 1} of {STEPS.length} — {currentStep.desc}
        </p>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-1 mb-8 overflow-x-auto pb-1">
        {STEPS.map((step, i) => (
          <div key={step.id} className="flex items-center gap-1 shrink-0">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
              i < stepIdx  ? 'bg-[#8B1A1A] text-white' :
              i === stepIdx ? 'bg-[#1A0A0A] dark:bg-[#F5F0ED] text-white dark:text-[#1A0A0A]' :
              'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#9B8B85]'
            }`}>
              {i < stepIdx ? <Check size={13} /> : i + 1}
            </div>
            <span className={`text-xs font-medium hidden sm:block ${
              i === stepIdx ? 'text-[#1A0A0A] dark:text-[#F5F0ED]' : 'text-[#9B8B85]'
            }`}>{step.title}</span>
            {i < STEPS.length - 1 && (
              <div className={`h-px w-4 sm:w-6 transition-colors ${i < stepIdx ? 'bg-[#8B1A1A]' : 'bg-[#F2EDE8] dark:bg-[#2A1A1A]'}`} />
            )}
          </div>
        ))}
      </div>

      <div className="mb-6">
        <h2 className="text-lg font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">{currentStep.title}</h2>
      </div>

      {currentStep.id === 'basics' && (
        <BasicsStep onNext={(d) => { setBasics(d); goNext() }} defaults={basics} />
      )}
      {currentStep.id === 'photos' && (
        <PhotosStep onNext={goNext} onBack={goBack} photos={photos} setPhotos={setPhotos} />
      )}
      {currentStep.id === 'ownership' && (
        <OwnershipStep onNext={goNext} onBack={goBack} ownershipFile={ownershipFile} setOwnershipFile={setOwnershipFile} />
      )}
      {currentStep.id === 'pricing' && (
        <PricingStep onNext={(d) => { setPricing(d); goNext() }} onBack={goBack} defaults={pricing} />
      )}
      {currentStep.id === 'requirements' && (
        <RequirementsStep
          onNext={(d) => { setRequirements(d); goNext() }}
          onBack={goBack}
          defaults={requirements}
          category={basics?.category}
          dailyRate={pricing?.daily_rate}
        />
      )}
      {currentStep.id === 'affiliates' && (
        <AffiliatesStep onNext={(d) => { setAffiliates(d); goNext() }} onBack={goBack} defaults={affiliates} />
      )}
      {currentStep.id === 'review' && (
        <ReviewStep
          onBack={goBack}
          onPublish={handlePublish}
          publishing={publishing}
          basics={basics}
          pricing={pricing}
          requirements={requirements}
          affiliates={affiliates}
          photoCount={photos.length}
          ownershipFileName={ownershipFile?.name ?? ''}
        />
      )}
    </div>
  )
}
