'use client'

import { useState, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations, type useTranslations as UseTranslationsType } from 'next-intl'
import { useRouter, Link } from '@/i18n/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import {
  ChevronLeft, ChevronRight, Check, Upload, X, ImagePlus,
  FileText, AlertCircle, ShieldCheck, Info, Star, UserCheck,
  ShoppingBag, Calendar, ArrowLeftRight,
} from 'lucide-react'
import { CATEGORIES, type ItemCondition, type ShippingPayer, type Listing, type ListingMedia, type ListingType } from '@/types'
import { calculateRiskTier, getRiskRequirements, type RiskTier } from '@/lib/risk/engine'
import { useAuth } from '@/hooks/use-auth'
import { validatePhotoFile, validateOwnershipProofFile, uploadListingPhoto, uploadOwnershipProof, removeUploadedFiles } from '@/lib/listings/storage'
import { DECLARATION_CATALOGUE } from '@/lib/listings/declarations'
import { CATEGORY_FIELD_SETS, getRequiredCategoryFieldKeys, type CategoryFieldDef } from '@/lib/listings/category-fields'
import type { ListingDraft } from '@/lib/data/listings'
import type { BlockedDateRange } from '@/lib/listings/validation'

type ListingCreationT = ReturnType<typeof UseTranslationsType<'merchant.listingCreation'>>

// ─── Step definitions ────────────────────────────────────────────────────────
// 'requirements' (deposit/renter criteria) only applies when the item can
// be rented — filtered out for a pure 'sale' listing, see the `steps`
// useMemo below. Every other step is genuinely shared between sell/rent/
// both (title, photos, ownership proof, affiliate settings — see
// docs/BUYING_SELLING.md's reasoning for why these aren't duplicated).

const BASE_STEPS = [
  { id: 'type' },
  { id: 'basics' },
  { id: 'photos' },
  { id: 'ownership' },
  { id: 'pricing' },
  { id: 'requirements' },
  { id: 'affiliates' },
  { id: 'review' },
] as const

type StepId = typeof BASE_STEPS[number]['id']

// ─── Zod schemas per step ────────────────────────────────────────────────────
// Built by functions (not module-level constants) so validation messages
// can be localized -- each Step component builds its schema via
// useMemo(() => makeXSchema(t), [t]), t sourced from useTranslations at
// component scope (schemas can't call hooks themselves, being outside any
// component).

function makeBasicsSchema(t: ListingCreationT) {
  return z.object({
    title:       z.string().min(10, t('basics.errors.titleTooShort')),
    category:    z.string().min(1, t('basics.errors.categoryRequired')),
    condition:   z.enum(['new', 'like_new', 'good', 'fair'] as const, { error: t('basics.errors.conditionRequired') }),
    description: z.string().min(50, t('basics.errors.descriptionTooShort')),
    replacement_value: z.number({ error: t('basics.errors.required') }).positive(t('basics.errors.replacementValueRequired')),
    quantity_available: z.number().int().min(1).max(100),
    province: z.string().min(1, t('basics.errors.required')),
    city: z.string().min(1, t('basics.errors.required')),
    category_metadata: z.record(z.string(), z.string()).optional(),
    private_category_metadata: z.record(z.string(), z.string()).optional(),
  })
}

// One schema, not three separate ones — PricingData needs to stay a
// single consistent type used by state/ReviewStep/persistDraft, and
// rental vs. sale vs. both differ only in WHICH fields are required, not
// in the shape. Requirement branching happens in superRefine, keyed off
// `listing_type` (always present — set by the Type step before Pricing
// is ever reached).
function makePricingSchema(t: ListingCreationT) {
  return z.object({
    listing_type:     z.enum(['rental', 'sale', 'both'] as const),
    daily_rate:       z.number().min(10, t('pricing.errors.minRate')).optional(),
    weekly_rate:      z.number().optional(),
    min_rental_days:  z.number().min(1).max(30).optional(),
    max_rental_days:  z.number().min(1).max(365).optional(),
    shipping_payer:   z.enum(['renter', 'merchant', 'split', 'negotiate'] as const),
    insurance_amount: z.number().optional(),
    available_from:   z.string().optional(),
    min_booking_notice_days: z.number().min(0).max(90).optional(),
    max_advance_booking_days: z.number().min(0).max(365).optional(),
    sale_price:       z.number().min(1, t('pricing.errors.salePriceRequired')).optional(),
  }).superRefine((d, ctx) => {
    const rentable = d.listing_type === 'rental' || d.listing_type === 'both'
    const sellable = d.listing_type === 'sale' || d.listing_type === 'both'

    if (rentable) {
      if (d.daily_rate === undefined) ctx.addIssue({ code: 'custom', message: t('basics.errors.required'), path: ['daily_rate'] })
      if (d.min_rental_days === undefined) ctx.addIssue({ code: 'custom', message: t('basics.errors.required'), path: ['min_rental_days'] })
      if (!d.available_from) ctx.addIssue({ code: 'custom', message: t('pricing.errors.availabilityStartRequired'), path: ['available_from'] })
      if (d.max_rental_days && d.min_rental_days && d.max_rental_days < d.min_rental_days) {
        ctx.addIssue({ code: 'custom', message: t('pricing.errors.maxLessThanMin'), path: ['max_rental_days'] })
      }
    }
    if (sellable && d.sale_price === undefined) {
      ctx.addIssue({ code: 'custom', message: t('basics.errors.required'), path: ['sale_price'] })
    }
  })
}

function makeRequirementsSchema(t: ListingCreationT) {
  return z.object({
    min_unity_score:  z.number().min(0).max(5),
    deposit_required: z.boolean(),
    deposit_amount:   z.number().optional(),
    verified_identity_required: z.boolean(),
    kyc_approved_required: z.boolean(),
    min_age: z.number().min(0).max(120).optional(),
    driving_licence_required: z.boolean(),
    licence_class: z.string().optional(),
    additional_requirements: z.string().max(2000).optional(),
    permitted_use: z.string().max(2000).optional(),
    prohibited_use: z.string().max(2000).optional(),
    geographic_restriction: z.string().max(500).optional(),
    commercial_use_allowed: z.boolean(),
    sub_rental_allowed: z.boolean(),
    cleaning_requirements: z.string().max(2000).optional(),
    return_condition_requirements: z.string().max(2000).optional(),
    merchant_custom_rules: z.string().max(2000).optional(),
    existing_damage_description: z.string().max(2000).optional(),
    inspection_required_before_handover: z.boolean(),
    inspection_required_on_return: z.boolean(),
    missing_accessory_consequence: z.string().max(1000).optional(),
    lost_item_consequence: z.string().max(1000).optional(),
  }).refine(
    (d) => !d.driving_licence_required || !!d.licence_class,
    { message: t('requirements.errors.licenceClassRequired'), path: ['licence_class'] }
  )
}

const affiliatesSchema = z.object({
  accepts_affiliates:        z.boolean(),
  affiliate_commission_rate: z.number().min(1).max(50).optional(),
})

type BasicsData       = z.infer<ReturnType<typeof makeBasicsSchema>>
type PricingData      = z.infer<ReturnType<typeof makePricingSchema>>
type RequirementsData = z.infer<ReturnType<typeof makeRequirementsSchema>>
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

// ─── Category-specific fields (vehicles/tech/tools only — see
// src/lib/listings/category-fields.ts) ─────────────────────────────────────

function CategoryFieldInput({ field, register, prefix }: {
  field: CategoryFieldDef
  register: ReturnType<typeof useForm<BasicsData>>['register']
  prefix: 'category_metadata' | 'private_category_metadata'
}) {
  const t = useTranslations('merchant.listingCreation')
  const name = `${prefix}.${field.key}` as `category_metadata.${string}` | `private_category_metadata.${string}`
  return (
    <div>
      <Label required={field.required}>{field.label}</Label>
      {field.type === 'select' ? (
        <select {...register(name)} className={inputCls()}>
          <option value="">{t('basics.genericSelectPlaceholder')}</option>
          {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input {...register(name)} className={inputCls()} />
      )}
    </div>
  )
}

function CategoryFieldsSection({ category, register }: {
  category: string
  register: ReturnType<typeof useForm<BasicsData>>['register']
}) {
  const t = useTranslations('merchant.listingCreation')
  const tCategories = useTranslations('common.categories')
  const set = CATEGORY_FIELD_SETS[category as keyof typeof CATEGORY_FIELD_SETS]
  if (!set) return null

  return (
    <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">
        {t('basics.categoryDetailsHeading', { category: tCategories(category) })}
      </p>
      {set.public.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {set.public.map((f) => <CategoryFieldInput key={f.key} field={f} register={register} prefix="category_metadata" />)}
        </div>
      )}
      {set.private.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-xs text-[#9B8B85] pt-1">
            <ShieldCheck size={12} /> {t('basics.keptPrivateNotice')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {set.private.map((f) => <CategoryFieldInput key={f.key} field={f} register={register} prefix="private_category_metadata" />)}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Step: Type (sell / rent / both) ───────────────────────────────────────────
// Drives every later step: Pricing branches its fields, and Requirements
// (rental-only deposit/renter-criteria) is skipped entirely for a pure
// 'sale' listing — see the `steps` useMemo in CreateListingFlow.

const TYPE_OPTION_VALUES: { value: ListingType; icon: React.ReactNode }[] = [
  { value: 'sale', icon: <ShoppingBag size={20} strokeWidth={1.5} /> },
  { value: 'rental', icon: <Calendar size={20} strokeWidth={1.5} /> },
  { value: 'both', icon: <ArrowLeftRight size={20} strokeWidth={1.5} /> },
]

function TypeStep({ onNext, defaults }: { onNext: (t: ListingType) => void; defaults?: ListingType }) {
  const t = useTranslations('merchant.listingCreation')
  const [selected, setSelected] = useState<ListingType>(defaults ?? 'rental')

  const labelFor = (v: ListingType) => (v === 'sale' ? t('type.sellLabel') : v === 'rental' ? t('type.rentLabel') : t('type.bothLabel'))
  const descFor = (v: ListingType) => (v === 'sale' ? t('type.sellDesc') : v === 'rental' ? t('type.rentDesc') : t('type.bothDesc'))

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" role="radiogroup" aria-label={t('steps.type.title')}>
        {TYPE_OPTION_VALUES.map(({ value, icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected === value}
            onClick={() => setSelected(value)}
            className={`relative flex flex-col items-start gap-2 p-5 rounded-xl border-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B1A1A] focus-visible:ring-offset-2 ${
              selected === value
                ? 'border-[#8B1A1A] bg-[#FAF8F5] dark:bg-[#1A1010]'
                : 'border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] hover:border-[#8B1A1A]/40'
            }`}
          >
            {selected === value && (
              <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-[#8B1A1A] flex items-center justify-center">
                <Check size={11} className="text-white" />
              </span>
            )}
            <div className="text-[#8B1A1A]">{icon}</div>
            <span className="text-sm font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tracking-wide">{labelFor(value)}</span>
            <span className="text-xs text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{descFor(value)}</span>
          </button>
        ))}
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={() => onNext(selected)}
          className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2"
        >
          {t('continue')} <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

// ─── Step: Basics ─────────────────────────────────────────────────────────────

function BasicsStep({ onNext, defaults }: { onNext: (d: BasicsData) => void; defaults?: Partial<BasicsData> }) {
  const t = useTranslations('merchant.listingCreation')
  const tCategories = useTranslations('common.categories')
  const basicsSchema = useMemo(() => makeBasicsSchema(t), [t])
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<BasicsData>({
    resolver: zodResolver(basicsSchema),
    defaultValues: { quantity_available: 1, ...defaults },
  })
  const description = watch('description') ?? ''
  const category = watch('category')
  const [categoryError, setCategoryError] = useState('')

  const handleValid = (d: BasicsData) => {
    const missing = getRequiredCategoryFieldKeys(category).filter((key) => {
      const set = CATEGORY_FIELD_SETS[category as keyof typeof CATEGORY_FIELD_SETS]
      const isPrivate = set?.private.some((f) => f.key === key)
      const value = isPrivate ? d.private_category_metadata?.[key] : d.category_metadata?.[key]
      return !value?.trim()
    })
    if (missing.length > 0) {
      setCategoryError(t('basics.categoryDetailsRequired', { category: tCategories(category) }))
      return
    }
    setCategoryError('')
    onNext(d)
  }

  return (
    <form onSubmit={handleSubmit(handleValid)} className="space-y-5">
      <div>
        <Label required>{t('basics.itemTitle')}</Label>
        <input {...register('title')} placeholder={t('basics.itemTitlePlaceholder')} className={inputCls(!!errors.title)} />
        <FieldError message={errors.title?.message} />
      </div>

      <div>
        <Label required>{t('basics.category')}</Label>
        <select {...register('category')} className={inputCls(!!errors.category)} onChange={(e) => {
          // Switching category invalidates any previously entered
          // category-specific values (they belong to the old category's
          // field set) — clear both metadata objects rather than letting
          // stale values silently persist. The server independently
          // strips anything not on the new category's allowlist regardless
          // (see save_listing_draft's sanitize_category_metadata call).
          setValue('category', e.target.value)
          setValue('category_metadata', {})
          setValue('private_category_metadata', {})
        }}>
          <option value="">{t('basics.categorySelectPlaceholder')}</option>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.icon} {tCategories(c.id)}</option>
          ))}
        </select>
        <FieldError message={errors.category?.message} />
      </div>

      {category && <CategoryFieldsSection category={category} register={register} />}
      {categoryError && <p className="flex items-center gap-1 text-xs text-[#E03D2F]"><AlertCircle size={11} />{categoryError}</p>}

      <div>
        <Label required>{t('basics.condition')}</Label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(['new', 'like_new', 'good', 'fair'] as ItemCondition[]).map((cond) => {
            const labels: Record<string, string> = {
              new: t('basics.conditionNew'), like_new: t('basics.conditionLikeNew'), good: t('basics.conditionGood'), fair: t('basics.conditionFair'),
            }
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
        <Label required>{t('basics.description')}</Label>
        <textarea
          {...register('description')}
          rows={5}
          placeholder={t('basics.descriptionPlaceholder')}
          className={inputCls(!!errors.description)}
        />
        <div className="flex items-center justify-between mt-1">
          <FieldError message={errors.description?.message} />
          <span className={`text-xs ml-auto ${description.length < 50 ? 'text-[#F2EDE8] dark:text-[#2A1A1A]' : 'text-[#9B8B85]'}`}>
            {t('basics.charCount', { count: description.length })}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required>{t('basics.replacementValue')}</Label>
          <input type="number" min={1} {...register('replacement_value', { valueAsNumber: true })} className={inputCls(!!errors.replacement_value)} />
          <FieldError message={errors.replacement_value?.message} />
        </div>
        <div>
          <Label required>{t('basics.quantityAvailable')}</Label>
          <input type="number" min={1} max={100} {...register('quantity_available', { valueAsNumber: true })} className={inputCls(!!errors.quantity_available)} />
          <FieldError message={errors.quantity_available?.message} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required>{t('basics.province')}</Label>
          <input {...register('province')} placeholder={t('basics.provincePlaceholder')} className={inputCls(!!errors.province)} />
          <FieldError message={errors.province?.message} />
        </div>
        <div>
          <Label required>{t('basics.city')}</Label>
          <input {...register('city')} placeholder={t('basics.cityPlaceholder')} className={inputCls(!!errors.city)} />
          <FieldError message={errors.city?.message} />
        </div>
      </div>

      <button type="submit" className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
        {t('continue')} <ChevronRight size={16} />
      </button>
    </form>
  )
}

// ─── Step: Photos ─────────────────────────────────────────────────────────────

function PhotosStep({
  onNext, onBack, photos, setPhotos, existingPhotos, onRemoveExisting, onReorderExisting,
  hasDeclaredDefects, hasDamagePhoto, setHasDamagePhoto,
}: {
  onNext: () => void
  onBack: () => void
  photos: File[]
  setPhotos: (f: File[]) => void
  existingPhotos: ListingMedia[]
  onRemoveExisting: (id: string) => void
  onReorderExisting: (next: ListingMedia[]) => void
  hasDeclaredDefects: boolean
  hasDamagePhoto: boolean
  setHasDamagePhoto: (v: boolean) => void
}) {
  const t = useTranslations('merchant.listingCreation')
  const [previews, setPreviews] = useState<string[]>(() => photos.map((f) => URL.createObjectURL(f)))
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return
    const rejected: string[] = []
    const valid = Array.from(files).filter((f) => {
      const err = validatePhotoFile(f)
      if (err) { rejected.push(`${f.name}: ${err}`); return false }
      return true
    })
    const newPreviews = valid.map((f) => URL.createObjectURL(f))
    setPhotos([...photos, ...valid])
    setPreviews((p) => [...p, ...newPreviews])
    setError(rejected.length ? rejected.join(' ') : '')
  }, [photos, setPhotos])

  const remove = (i: number) => {
    URL.revokeObjectURL(previews[i])
    setPhotos(photos.filter((_, idx) => idx !== i))
    setPreviews((p) => p.filter((_, idx) => idx !== i))
  }

  const moveExisting = (i: number, dir: -1 | 1) => {
    const next = [...existingPhotos]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onReorderExisting(next)
  }

  const makePrimary = (i: number) => {
    if (i === 0) return
    const next = [...existingPhotos]
    const [item] = next.splice(i, 1)
    next.unshift(item)
    onReorderExisting(next)
  }

  const totalCount = existingPhotos.length + photos.length
  const primaryIsExisting = existingPhotos.length > 0

  const handleNext = () => {
    if (totalCount < 3) { setError(t('photos.errors.minPhotos')); return }
    if (hasDeclaredDefects && !hasDamagePhoto) {
      setError(t('photos.errors.damagePhotoRequired'))
      return
    }
    onNext()
  }

  return (
    <div className="space-y-5">
      <div>
        <Label required>{t('photos.heading')}</Label>
        <p className="text-xs text-[#9B8B85] mb-3">{t('photos.desc')}</p>

        <div
          className="border-2 border-dashed border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-8 text-center cursor-pointer hover:border-[#8B1A1A] dark:hover:border-[#8B1A1A] transition-colors"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
        >
          <ImagePlus size={28} className="mx-auto text-[#9B8B85] mb-2" />
          <p className="text-sm font-medium text-[#6B5B55] dark:text-[#9B8B85]">{t('photos.dropzoneTitle')}</p>
          <p className="text-xs text-[#9B8B85] mt-1">{t('photos.dropzoneHint')}</p>
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

      {(existingPhotos.length > 0 || previews.length > 0) && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {existingPhotos.map((m, i) => (
            <div key={m.id} className="relative aspect-square rounded-xl overflow-hidden bg-[#FAF8F5] dark:bg-[#1A1010] group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.url} alt={t('photos.existingPhotoAlt', { index: i + 1 })} className="w-full h-full object-cover" />
              {i === 0 && (
                <span className="absolute bottom-1 left-1 text-[10px] font-bold bg-[#1A0A0A]/80 text-white px-1.5 py-0.5 rounded-full">{t('photos.cover')}</span>
              )}
              <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {i > 0 && (
                  <button onClick={() => makePrimary(i)} title={t('photos.makePrimary')} className="w-6 h-6 rounded-full bg-[#1A0A0A]/70 text-white flex items-center justify-center hover:bg-amber-500">
                    <Star size={11} />
                  </button>
                )}
                {i > 0 && (
                  <button onClick={() => moveExisting(i, -1)} title={t('photos.moveEarlier')} className="w-6 h-6 rounded-full bg-[#1A0A0A]/70 text-white flex items-center justify-center hover:bg-[#8B1A1A]">
                    <ChevronLeft size={11} />
                  </button>
                )}
                {i < existingPhotos.length - 1 && (
                  <button onClick={() => moveExisting(i, 1)} title={t('photos.moveLater')} className="w-6 h-6 rounded-full bg-[#1A0A0A]/70 text-white flex items-center justify-center hover:bg-[#8B1A1A]">
                    <ChevronRight size={11} />
                  </button>
                )}
                <button onClick={() => onRemoveExisting(m.id)} title={t('photos.remove')} className="w-6 h-6 rounded-full bg-[#1A0A0A]/70 text-white flex items-center justify-center hover:bg-[#E03D2F]">
                  <X size={11} />
                </button>
              </div>
            </div>
          ))}
          {previews.map((src, i) => (
            <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-[#FAF8F5] dark:bg-[#1A1010] group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={t('photos.newPhotoAlt', { index: i + 1 })} className="w-full h-full object-cover" />
              {!primaryIsExisting && i === 0 && (
                <span className="absolute bottom-1 left-1 text-[10px] font-bold bg-[#1A0A0A]/80 text-white px-1.5 py-0.5 rounded-full">{t('photos.cover')}</span>
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
            {t('photos.addMore')}
          </button>
        </div>
      )}

      {hasDeclaredDefects && (
        <label className="flex items-start gap-3 p-4 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 cursor-pointer">
          <input
            type="checkbox"
            checked={hasDamagePhoto}
            onChange={(e) => setHasDamagePhoto(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {t('photos.damagePhotoNotice')}
          </span>
        </label>
      )}

      <div className="flex gap-3 pt-2">
        <button onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> {t('back')}
        </button>
        <button onClick={handleNext} className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          {t('continue')} <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

// ─── Step: Ownership proof ────────────────────────────────────────────────────

function OwnershipStep({
  onNext, onBack, ownershipFile, setOwnershipFile, hasExistingOwnershipProof,
  conditionConfirmed, setConditionConfirmed, knownDefects, setKnownDefects,
}: {
  onNext: () => void
  onBack: () => void
  ownershipFile: File | null
  setOwnershipFile: (f: File | null) => void
  hasExistingOwnershipProof: boolean
  conditionConfirmed: boolean
  setConditionConfirmed: (v: boolean) => void
  knownDefects: string
  setKnownDefects: (v: string) => void
}) {
  const t = useTranslations('merchant.listingCreation')
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')

  const handleNext = () => {
    if (!ownershipFile && !hasExistingOwnershipProof) { setError(t('ownership.errors.proofRequired')); return }
    if (!conditionConfirmed) { setError(t('ownership.errors.confirmRequired')); return }
    onNext()
  }

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-4 flex gap-3">
        <Info size={16} className="text-blue-500 shrink-0 mt-0.5" />
        <div className="text-sm text-blue-700 dark:text-blue-300">
          <p className="font-medium mb-1">{t('ownership.whyHeading')}</p>
          <p className="text-xs leading-relaxed text-blue-600 dark:text-blue-400">
            {t('ownership.whyBody')}
          </p>
        </div>
      </div>

      <div>
        <Label required>{t('ownership.proofLabel')}</Label>
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
        ) : hasExistingOwnershipProof ? (
          <div className="flex items-center gap-3 p-4 border border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl">
            <FileText size={20} className="text-[#9B8B85] shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{t('ownership.existingProofTitle')}</p>
              <p className="text-xs text-[#9B8B85]">{t('ownership.existingProofDesc')}</p>
            </div>
            <button onClick={() => inputRef.current?.click()} className="text-xs font-semibold uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline">
              {t('ownership.replace')}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,application/pdf,video/mp4"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                const err = validateOwnershipProofFile(f)
                if (err) { setError(err); return }
                setOwnershipFile(f); setError('')
              }}
            />
          </div>
        ) : (
          <div
            className="border-2 border-dashed border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-8 text-center cursor-pointer hover:border-[#8B1A1A] dark:hover:border-[#8B1A1A] transition-colors"
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={28} className="mx-auto text-[#9B8B85] mb-2" />
            <p className="text-sm font-medium text-[#6B5B55] dark:text-[#9B8B85]">{t('ownership.dropzoneTitle')}</p>
            <p className="text-xs text-[#9B8B85] mt-1">{t('ownership.dropzoneHint')}</p>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,application/pdf,video/mp4"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                const err = validateOwnershipProofFile(f)
                if (err) { setError(err); return }
                setOwnershipFile(f); setError('')
              }}
            />
          </div>
        )}
        {error && <p className="flex items-center gap-1 text-xs text-[#E03D2F] mt-2"><AlertCircle size={11} />{error}</p>}
      </div>

      <div>
        <Label>{t('ownership.knownDefectsLabel')} <span className="text-[#9B8B85] font-normal text-xs">{t('ownership.knownDefectsLabelHint')}</span></Label>
        <textarea
          value={knownDefects}
          onChange={(e) => setKnownDefects(e.target.value)}
          rows={3}
          placeholder={t('ownership.knownDefectsPlaceholder')}
          className={inputCls()}
        />
        <p className="text-xs text-[#9B8B85] mt-1">{t('ownership.knownDefectsNotice')}</p>
      </div>

      <label className="flex items-start gap-3 p-4 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] cursor-pointer">
        <input
          type="checkbox"
          checked={conditionConfirmed}
          onChange={(e) => setConditionConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          {t('ownership.confirmLabel')}
        </span>
      </label>

      <div className="flex gap-3 pt-2">
        <button onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> {t('back')}
        </button>
        <button onClick={handleNext} className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          {t('continue')} <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

// ─── Step: Pricing ────────────────────────────────────────────────────────────

function BlockedDatesWidget({ ranges, setRanges }: { ranges: BlockedDateRange[]; setRanges: (r: BlockedDateRange[]) => void }) {
  const t = useTranslations('merchant.listingCreation')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')

  const add = () => {
    if (!start || !end) { setError(t('pricing.blockedDates.errors.chooseDates')); return }
    if (start > end) { setError(t('pricing.blockedDates.errors.startBeforeEnd')); return }
    const overlaps = ranges.some((r) => start <= r.end_date && r.start_date <= end)
    if (overlaps) { setError(t('pricing.blockedDates.errors.overlap')); return }
    setRanges([...ranges, { start_date: start, end_date: end, reason: reason || undefined }])
    setStart(''); setEnd(''); setReason(''); setError('')
  }

  return (
    <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-3">
      <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('pricing.blockedDates.heading')}</p>
      <p className="text-xs text-[#9B8B85]">{t('pricing.blockedDates.desc')}</p>
      {ranges.length > 0 && (
        <div className="space-y-1.5">
          {ranges.map((r, i) => (
            <div key={`${r.start_date}-${r.end_date}`} className="flex items-center justify-between text-xs bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg px-3 py-2">
              <span>{r.start_date} → {r.end_date}{r.reason ? ` · ${r.reason}` : ''}</span>
              <button type="button" onClick={() => setRanges(ranges.filter((_, idx) => idx !== i))} className="text-[#9B8B85] hover:text-[#E03D2F]">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls()} />
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls()} />
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('pricing.blockedDates.reasonPlaceholder')} className={`${inputCls()} col-span-2 sm:col-span-1`} />
      </div>
      {error && <p className="flex items-center gap-1 text-xs text-[#E03D2F]"><AlertCircle size={11} />{error}</p>}
      <button type="button" onClick={add} className="text-xs font-semibold uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline">
        {t('pricing.blockedDates.addRange')}
      </button>
    </div>
  )
}

function PricingStep({
  onNext, onBack, defaults, blockedRanges, setBlockedRanges, listingType,
}: {
  onNext: (d: PricingData) => void
  onBack: () => void
  defaults?: Partial<PricingData>
  blockedRanges: BlockedDateRange[]
  setBlockedRanges: (r: BlockedDateRange[]) => void
  listingType: ListingType
}) {
  const t = useTranslations('merchant.listingCreation')
  const rentable = listingType === 'rental' || listingType === 'both'
  const sellable = listingType === 'sale' || listingType === 'both'

  const pricingSchema = useMemo(() => makePricingSchema(t), [t])
  const { register, handleSubmit, formState: { errors } } = useForm<PricingData>({
    resolver: zodResolver(pricingSchema),
    defaultValues: { min_rental_days: 1, shipping_payer: 'renter', ...defaults, listing_type: listingType },
  })

  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-5">
      {sellable && (
        <div>
          <Label required>{t('pricing.salePrice')}</Label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
            <input type="number" min={1} {...register('sale_price', { valueAsNumber: true })} placeholder="0" className={`${inputCls(!!errors.sale_price)} pl-8`} />
          </div>
          <FieldError message={errors.sale_price?.message} />
        </div>
      )}

      {rentable && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label required>{t('pricing.dailyRate')}</Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
                <input type="number" min={10} {...register('daily_rate', { valueAsNumber: true })} placeholder="0" className={`${inputCls(!!errors.daily_rate)} pl-8`} />
              </div>
              <FieldError message={errors.daily_rate?.message} />
            </div>

            <div>
              <Label>{t('pricing.weeklyRate')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
                <input type="number" min={0} {...register('weekly_rate', { valueAsNumber: true })} placeholder="0" className={`${inputCls(!!errors.weekly_rate)} pl-8`} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label required>{t('pricing.minRentalDays')}</Label>
              <input type="number" min={1} max={30} {...register('min_rental_days', { valueAsNumber: true })} className={inputCls(!!errors.min_rental_days)} />
              <FieldError message={errors.min_rental_days?.message} />
            </div>

            <div>
              <Label>{t('pricing.insurancePerDay')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
                <input type="number" min={0} {...register('insurance_amount', { valueAsNumber: true })} placeholder="0" className={`${inputCls()} pl-8`} />
              </div>
              <p className="text-xs text-[#9B8B85] mt-1">{t('pricing.insuranceHint')}</p>
            </div>
          </div>
        </>
      )}

      <div>
        <Label required>{t('pricing.whoPaysShipping')}</Label>
        <div className="grid grid-cols-2 gap-2">
          {([
            ['renter',    t('pricing.shippingRenter')],
            ['merchant',  t('pricing.shippingMerchant')],
            ['split',     t('pricing.shippingSplit')],
            ['negotiate', t('pricing.shippingNegotiate')],
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

      {rentable && (
        <>
          <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-4">
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('pricing.availabilityHeading')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label required>{t('pricing.availableFrom')}</Label>
                <input type="date" {...register('available_from')} className={inputCls(!!errors.available_from)} />
                <FieldError message={errors.available_from?.message} />
              </div>
              <div>
                <Label>{t('pricing.maxRentalDays')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
                <input type="number" min={1} max={365} {...register('max_rental_days', { valueAsNumber: true })} className={inputCls(!!errors.max_rental_days)} />
                <FieldError message={errors.max_rental_days?.message} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>{t('pricing.minBookingNotice')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
                <input type="number" min={0} max={90} {...register('min_booking_notice_days', { valueAsNumber: true })} className={inputCls()} />
              </div>
              <div>
                <Label>{t('pricing.maxAdvanceBooking')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
                <input type="number" min={0} max={365} {...register('max_advance_booking_days', { valueAsNumber: true })} className={inputCls()} />
              </div>
            </div>
          </div>

          <BlockedDatesWidget ranges={blockedRanges} setRanges={setBlockedRanges} />
        </>
      )}

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> {t('back')}
        </button>
        <button type="submit" className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          {t('continue')} <ChevronRight size={16} />
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
  const t = useTranslations('merchant.listingCreation')
  const { profile } = useAuth()
  const requirementsSchema = useMemo(() => makeRequirementsSchema(t), [t])
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<RequirementsData>({
    resolver: zodResolver(requirementsSchema),
    defaultValues: {
      min_unity_score: 0, deposit_required: false,
      verified_identity_required: false, kyc_approved_required: false, driving_licence_required: false,
      commercial_use_allowed: false, sub_rental_allowed: false,
      inspection_required_before_handover: false, inspection_required_on_return: false,
      ...defaults,
    },
  })
  const depositRequired = watch('deposit_required')
  const drivingLicenceRequired = watch('driving_licence_required')

  const riskTier = calculateRiskTier({
    category: category ?? '',
    dailyRate: dailyRate ?? 0,
    merchantKycStatus: profile?.kyc_status ?? 'none',
    merchantUnityScore: profile?.unity_score ?? 0,
  })
  const riskRequirements = getRiskRequirements(riskTier)
  const riskTierLabel = riskTier === 'low' ? t('requirements.riskTierLow') : riskTier === 'medium' ? t('requirements.riskTierMedium') : t('requirements.riskTierHigh')

  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-5">
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-xl p-4 flex gap-3">
        <Info size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          {t('requirements.infoNotice')}
        </p>
      </div>

      {/* Unity Score */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Star size={16} className="text-amber-400 fill-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('requirements.unityScoreHeading')}</p>
            <p className="text-xs text-[#9B8B85] mt-0.5">{t('requirements.unityScoreDesc')}</p>
          </div>
        </div>
        <select {...register('min_unity_score', { valueAsNumber: true })} className={inputCls()}>
          <option value={0}>{t('requirements.unityScoreNone')}</option>
          <option value={3.0}>{t('requirements.unityScoreGood')}</option>
          <option value={3.5}>{t('requirements.unityScoreTrusted')}</option>
          <option value={4.0}>{t('requirements.unityScoreHighlyTrusted')}</option>
          <option value={4.5}>{t('requirements.unityScoreElite')}</option>
        </select>
      </div>

      {/* Security deposit */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <ShieldCheck size={16} className="text-[#9B8B85] shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('requirements.depositHeading')}</p>
              <p className="text-xs text-[#9B8B85] mt-0.5">{t('requirements.depositDesc')}</p>
            </div>
          </div>
          <Toggle checked={depositRequired} onChange={(v) => setValue('deposit_required', v)} />
        </div>
        {depositRequired && (
          <div>
            <Label required>{t('requirements.depositAmount')}</Label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">R</span>
              <input type="number" min={0} {...register('deposit_amount', { valueAsNumber: true })} placeholder="0" className={`${inputCls()} pl-8`} />
            </div>
          </div>
        )}
      </div>

      {/* Renter requirements */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-3">
        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('requirements.renterRequirementsHeading')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" {...register('verified_identity_required')} /> {t('requirements.verifiedIdentityRequired')}
          </label>
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" {...register('kyc_approved_required')} /> {t('requirements.kycApprovedRequired')}
          </label>
          <div>
            <Label>{t('requirements.minAge')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
            <input type="number" min={0} max={120} {...register('min_age', { valueAsNumber: true })} className={inputCls()} />
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
              <input type="checkbox" {...register('driving_licence_required')} /> {t('requirements.drivingLicenceRequired')}
            </label>
            {drivingLicenceRequired && (
              <div>
                <input {...register('licence_class')} placeholder={t('requirements.licenceClassPlaceholder')} className={inputCls(!!errors.licence_class)} />
                <FieldError message={errors.licence_class?.message} />
              </div>
            )}
          </div>
        </div>
        <div>
          <Label>{t('requirements.additionalRequirements')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
          <textarea {...register('additional_requirements')} rows={2} className={inputCls()} />
        </div>
      </div>

      {/* Usage rules */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-3">
        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('requirements.usageRulesHeading')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>{t('requirements.permittedUse')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
            <textarea {...register('permitted_use')} rows={2} className={inputCls()} />
          </div>
          <div>
            <Label>{t('requirements.prohibitedUse')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
            <textarea {...register('prohibited_use')} rows={2} className={inputCls()} />
          </div>
        </div>
        <div>
          <Label>{t('requirements.geographicRestriction')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
          <input {...register('geographic_restriction')} placeholder={t('requirements.geographicRestrictionPlaceholder')} className={inputCls()} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" {...register('commercial_use_allowed')} /> {t('requirements.commercialUseAllowed')}
          </label>
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" {...register('sub_rental_allowed')} /> {t('requirements.subRentalAllowed')}
          </label>
        </div>
        <div>
          <Label>{t('requirements.cleaningRequirements')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
          <textarea {...register('cleaning_requirements')} rows={2} className={inputCls()} />
        </div>
        <div>
          <Label>{t('requirements.returnConditionRequirements')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
          <textarea {...register('return_condition_requirements')} rows={2} className={inputCls()} />
        </div>
        <div>
          <Label>{t('requirements.additionalRules')} <span className="text-[#9B8B85] font-normal text-xs">{t('requirements.additionalRulesHint')}</span></Label>
          <textarea {...register('merchant_custom_rules')} rows={2} className={inputCls()} />
        </div>
      </div>

      {/* Damage & inspection */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-3">
        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('requirements.damageInspectionHeading')}</p>
        <div>
          <Label>{t('requirements.existingDamageDescription')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
          <textarea {...register('existing_damage_description')} rows={2} className={inputCls()} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" {...register('inspection_required_before_handover')} /> {t('requirements.inspectionBeforeHandover')}
          </label>
          <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" {...register('inspection_required_on_return')} /> {t('requirements.inspectionOnReturn')}
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>{t('requirements.missingAccessoryConsequence')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
            <textarea {...register('missing_accessory_consequence')} rows={2} className={inputCls()} />
          </div>
          <div>
            <Label>{t('requirements.lostItemConsequence')} <span className="text-[#9B8B85] font-normal text-xs">{t('optional')}</span></Label>
            <textarea {...register('lost_item_consequence')} rows={2} className={inputCls()} />
          </div>
        </div>
      </div>

      {/* Risk tier — automatic, not merchant-configurable */}
      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4">
        <div className="flex items-start gap-3">
          <UserCheck size={16} className="text-[#9B8B85] shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
              {t('requirements.riskTierHeading', { tier: riskTierLabel })}
            </p>
            <p className="text-xs text-[#9B8B85] mt-0.5">
              {t('requirements.riskTierDesc')}
            </p>
            <ul className="mt-3 space-y-1 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
              {riskRequirements.ownershipVerificationRequired && <li>• {t('requirements.riskOwnershipVerification')}</li>}
              {riskRequirements.inspectionVideoRequired && <li>• {t('requirements.riskInspectionVideo')}</li>}
              {riskRequirements.depositRequired && <li>• {t('requirements.riskDepositMandatory')}</li>}
              {!riskRequirements.depositRequired && riskRequirements.depositRecommended && (
                <li>• {t('requirements.riskDepositRecommended')}</li>
              )}
              {riskRequirements.insuranceRequired && <li>• {t('requirements.riskInsuranceMandatory')}</li>}
              {riskRequirements.manualReviewRequired && <li>• {t('requirements.riskManualReview')}</li>}
              {riskTier === 'low' && <li>• {t('requirements.riskNoRequirements')}</li>}
            </ul>
          </div>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> {t('back')}
        </button>
        <button type="submit" className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          {t('continue')} <ChevronRight size={16} />
        </button>
      </div>
    </form>
  )
}

// ─── Step: Affiliates ─────────────────────────────────────────────────────────

function AffiliatesStep({ onNext, onBack, defaults, affiliateEnabled }: { onNext: (d: AffiliatesData) => void; onBack: () => void; defaults?: Partial<AffiliatesData>; affiliateEnabled: boolean }) {
  const t = useTranslations('merchant.listingCreation')
  const { register, handleSubmit, watch } = useForm<AffiliatesData>({
    resolver: zodResolver(affiliatesSchema),
    // A grandfathered listing (accepts_affiliates already true from before
    // a downgrade) still shows its existing state truthfully even when
    // affiliateEnabled is now false -- only NEW enabling is blocked, not
    // display of already-saved history (matches the server's own
    // transition-only gate in save_listing_draft).
    defaultValues: { accepts_affiliates: false, ...defaults },
  })
  const acceptsAffiliates = watch('accepts_affiliates')
  const wasAlreadyEnabled = defaults?.accepts_affiliates === true

  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-5">
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-xl p-4 flex gap-3">
        <Info size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          {t('affiliates.infoNotice')}
        </p>
      </div>

      {!affiliateEnabled && !wasAlreadyEnabled && (
        <div className="bg-[#F2EDE8] dark:bg-[#2A1A1A] border border-[#E8E0D8] dark:border-[#3A2A2A] rounded-xl p-4">
          <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('affiliates.requiresUpgrade')}</p>
          <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-1">{t('affiliates.requiresUpgradeDesc')}</p>
        </div>
      )}

      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-2xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className={`text-sm font-semibold ${affiliateEnabled || wasAlreadyEnabled ? 'text-[#1A0A0A] dark:text-[#F5F0ED]' : 'text-[#9B8B85]'}`}>{t('affiliates.acceptAffiliates')}</p>
            <p className="text-xs text-[#9B8B85] mt-0.5">{t('affiliates.acceptAffiliatesDesc')}</p>
          </div>
          <label className={`relative inline-flex items-center ${affiliateEnabled || wasAlreadyEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="checkbox"
              {...register('accepts_affiliates')}
              disabled={!affiliateEnabled && !wasAlreadyEnabled}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-[#F2EDE8] dark:bg-[#2A1A1A] rounded-full peer peer-checked:bg-[#8B1A1A] transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
          </label>
        </div>

        {acceptsAffiliates && (
          <div>
            <Label required>{t('affiliates.commissionRate')}</Label>
            <div className="relative">
              <input
                type="number"
                min={1}
                max={50}
                {...register('affiliate_commission_rate', { valueAsNumber: true })}
                placeholder={t('affiliates.commissionRatePlaceholder')}
                className={`${inputCls()} pr-8`}
              />
              <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-[#9B8B85] font-medium">%</span>
            </div>
            <p className="text-xs text-[#9B8B85] mt-1">{t('affiliates.commissionRateHint')}</p>
          </div>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onBack} className="flex-1 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> {t('back')}
        </button>
        <button type="submit" className="flex-1 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors flex items-center justify-center gap-2">
          {t('affiliates.reviewListing')} <ChevronRight size={16} />
        </button>
      </div>
    </form>
  )
}

// ─── Step: Review & Publish ───────────────────────────────────────────────────

function ReviewStep({
  onBack, onSaveDraft, onSubmit, saving, submitting, serverError,
  basics, pricing, requirements, affiliates, photoCount, ownershipFileName, hasOwnershipProof,
  acceptedDeclarations, onToggleDeclaration,
}: {
  onBack: () => void
  onSaveDraft: () => void
  onSubmit: () => void
  saving: boolean
  submitting: boolean
  serverError: string
  basics?: BasicsData
  pricing?: PricingData
  requirements?: RequirementsData
  affiliates?: AffiliatesData
  photoCount: number
  ownershipFileName: string
  hasOwnershipProof: boolean
  acceptedDeclarations: Set<string>
  onToggleDeclaration: (type: string) => void
}) {
  const t = useTranslations('merchant.listingCreation')
  const tCategories = useTranslations('common.categories')
  const { profile } = useAuth()
  const riskTier = calculateRiskTier({
    category: basics?.category ?? '',
    dailyRate: pricing?.daily_rate ?? 0,
    merchantKycStatus: profile?.kyc_status ?? 'none',
    merchantUnityScore: profile?.unity_score ?? 0,
  })
  const riskTierLabel = riskTier === 'low' ? t('requirements.riskTierLow') : riskTier === 'medium' ? t('requirements.riskTierMedium') : t('requirements.riskTierHigh')
  const busy = saving || submitting
  const allDeclarationsAccepted = DECLARATION_CATALOGUE.every((d) => acceptedDeclarations.has(d.type))

  const conditionLabels: Record<string, string> = {
    new: t('basics.conditionNew'), like_new: t('basics.conditionLikeNew'), good: t('basics.conditionGood'), fair: t('basics.conditionFair'),
  }
  const listingTypeLabels: Record<string, string> = {
    rental: t('review.listingTypeRental'), sale: t('review.listingTypeSale'), both: t('review.listingTypeBoth'),
  }
  const shippingLabels: Record<string, string> = {
    renter: t('review.shippingRenter'), merchant: t('review.shippingMerchantFree'), split: t('review.shippingSplit'), negotiate: t('review.shippingNegotiate'),
  }

  const rows: [string, string][] = [
    [t('review.rows.title'),        basics?.title ?? t('review.dash')],
    [t('review.rows.category'),     basics?.category ? tCategories(basics.category) : t('review.dash')],
    [t('review.rows.condition'),    basics?.condition ? conditionLabels[basics.condition] : t('review.dash')],
    [t('review.rows.listingType'), pricing?.listing_type ? listingTypeLabels[pricing.listing_type] : t('review.dash')],
    [t('review.rows.salePrice'),   pricing?.sale_price ? `R${pricing.sale_price}` : t('review.notForSale')],
    [t('review.rows.dailyRate'),   pricing?.daily_rate ? `R${pricing.daily_rate}` : t('review.dash')],
    [t('review.rows.weeklyRate'),  pricing?.weekly_rate ? `R${pricing.weekly_rate}` : t('review.notSet')],
    [t('review.rows.minDays'),     pricing?.min_rental_days ? t('review.daysUnit', { count: pricing.min_rental_days }) : t('review.dash')],
    [t('review.rows.insurance'),    pricing?.insurance_amount ? `R${pricing.insurance_amount}/day` : t('review.none')],
    [t('review.rows.shipping'),     pricing?.shipping_payer ? shippingLabels[pricing.shipping_payer] : t('review.dash')],
    [t('review.rows.minUnityScore'), requirements?.min_unity_score ? `${requirements.min_unity_score}+` : t('review.noMinimum')],
    [t('review.rows.deposit'),      requirements?.deposit_required ? `R${requirements.deposit_amount ?? 0}` : t('review.none')],
    [t('review.rows.riskTier'),    riskTierLabel],
    [t('review.rows.affiliates'),   affiliates?.accepts_affiliates ? t('review.yesCommission', { rate: affiliates.affiliate_commission_rate ?? 0 }) : t('review.no')],
    [t('review.rows.photos'),       t('review.photosUploaded', { count: photoCount })],
    [t('review.rows.ownership'),    ownershipFileName || (hasOwnershipProof ? t('review.onFile') : t('review.dash'))],
  ]

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-4 flex gap-3">
        <ShieldCheck size={16} className="text-blue-500 shrink-0 mt-0.5" />
        <p className="text-sm text-blue-700 dark:text-blue-300">
          {t('review.submitNotice')}
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

      <div className="space-y-2">
        <Label required>{t('review.declarationsLabel')}</Label>
        {DECLARATION_CATALOGUE.map((d) => (
          <label key={d.type} className="flex items-start gap-3 p-3 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] cursor-pointer">
            <input
              type="checkbox"
              checked={acceptedDeclarations.has(d.type)}
              onChange={() => onToggleDeclaration(d.type)}
              className="mt-0.5"
            />
            <span className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">{d.wording}</span>
          </label>
        ))}
        <p className="text-[11px] text-[#9B8B85]">
          {t('review.fullPolicyText')} <Link href="/rental-terms" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">{t('review.rentalTerms')}</Link>{' '}
          {t('review.and')} <Link href="/prohibited-items" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">{t('review.prohibitedItemsPolicy')}</Link>.
        </p>
      </div>

      {serverError && (
        <p className="flex items-center gap-2 text-sm text-[#E03D2F] bg-[#E03D2F]/10 rounded-xl px-4 py-3">
          <AlertCircle size={14} className="shrink-0" /> {serverError}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3 pt-2">
        <button onClick={onBack} disabled={busy} className="py-3 px-5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] disabled:opacity-60 transition-colors flex items-center justify-center gap-2">
          <ChevronLeft size={16} /> {t('back')}
        </button>
        <button
          onClick={onSaveDraft}
          disabled={busy}
          className="flex-1 py-3 border border-[#8B1A1A] text-[#8B1A1A] font-semibold rounded-xl hover:bg-[#8B1A1A]/5 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
        >
          {saving ? <><span className="w-4 h-4 border-2 border-[#8B1A1A]/30 border-t-[#8B1A1A] rounded-full animate-spin" /> {t('review.saving')}</> : t('review.saveAsDraft')}
        </button>
        <button
          onClick={onSubmit}
          disabled={busy || !allDeclarationsAccepted}
          title={!allDeclarationsAccepted ? t('review.acceptAllToSubmit') : undefined}
          className="flex-1 py-3 bg-[#8B1A1A] hover:bg-[#7A1616] disabled:opacity-60 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          {submitting ? (
            <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('review.submitting')}</>
          ) : (
            <><Check size={16} /> {t('review.submitForReview')}</>
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

function listingToBasics(l: Listing, privateCategoryMetadata?: Record<string, string | undefined>): BasicsData {
  return {
    title: l.title,
    category: l.category,
    condition: (l.condition ?? 'good') as ItemCondition,
    description: l.description ?? '',
    replacement_value: l.replacement_value ?? 0,
    quantity_available: l.quantity_available ?? 1,
    province: l.province ?? '',
    city: l.city ?? '',
    category_metadata: (l.category_metadata as Record<string, string> | null) ?? {},
    private_category_metadata: (privateCategoryMetadata as Record<string, string> | undefined) ?? {},
  }
}
function listingToPricing(l: Listing): PricingData {
  return {
    listing_type: l.listing_type ?? 'rental',
    daily_rate: l.daily_rate ?? undefined,
    sale_price: l.sale_price ?? undefined,
    weekly_rate: l.weekly_rate ?? undefined,
    min_rental_days: l.min_rental_days,
    max_rental_days: l.max_rental_days ?? undefined,
    shipping_payer: l.shipping_payer,
    insurance_amount: l.insurance_amount ?? undefined,
    available_from: l.available_from ?? '',
    min_booking_notice_days: l.min_booking_notice_days ?? undefined,
    max_advance_booking_days: l.max_advance_booking_days ?? undefined,
  }
}
function listingToRequirements(l: Listing, req?: Record<string, unknown> | null): RequirementsData {
  return {
    min_unity_score: l.min_unity_score,
    deposit_required: l.deposit_required,
    deposit_amount: l.deposit_amount ?? undefined,
    verified_identity_required: (req?.verified_identity_required as boolean) ?? false,
    kyc_approved_required: (req?.kyc_approved_required as boolean) ?? false,
    min_age: (req?.min_age as number | null) ?? undefined,
    driving_licence_required: (req?.driving_licence_required as boolean) ?? false,
    licence_class: (req?.licence_class as string | null) ?? undefined,
    additional_requirements: (req?.additional_requirements as string | null) ?? undefined,
    permitted_use: (req?.permitted_use as string | null) ?? undefined,
    prohibited_use: (req?.prohibited_use as string | null) ?? undefined,
    geographic_restriction: (req?.geographic_restriction as string | null) ?? undefined,
    commercial_use_allowed: (req?.commercial_use_allowed as boolean) ?? false,
    sub_rental_allowed: (req?.sub_rental_allowed as boolean) ?? false,
    cleaning_requirements: (req?.cleaning_requirements as string | null) ?? undefined,
    return_condition_requirements: (req?.return_condition_requirements as string | null) ?? undefined,
    merchant_custom_rules: (req?.merchant_custom_rules as string | null) ?? undefined,
    existing_damage_description: (req?.existing_damage_description as string | null) ?? undefined,
    inspection_required_before_handover: (req?.inspection_required_before_handover as boolean) ?? false,
    inspection_required_on_return: (req?.inspection_required_on_return as boolean) ?? false,
    missing_accessory_consequence: (req?.missing_accessory_consequence as string | null) ?? undefined,
    lost_item_consequence: (req?.lost_item_consequence as string | null) ?? undefined,
  }
}
function listingToAffiliates(l: Listing): AffiliatesData {
  return { accepts_affiliates: l.accepts_affiliates, affiliate_commission_rate: l.affiliate_commission_rate || undefined }
}

export function CreateListingFlow({ draft, affiliateEnabled = false }: { draft?: ListingDraft; affiliateEnabled?: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('merchant.listingCreation')
  const { profile } = useAuth()
  const [stepIdx, setStepIdx] = useState(0)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState('')
  const busyRef = useRef(false)
  // Idempotency keys (server-enforced — see 20260729000008's
  // save_listing_draft/submit_listing_for_review). Reused across a failed
  // attempt + manual retry of the SAME logical action (the point of
  // idempotency — the server may have actually succeeded even if the
  // client never saw the response), and only rotated after a confirmed
  // success, since resending an old key with a since-edited payload would
  // otherwise hit the server's "reused key with a different request" guard.
  const saveIdemKeyRef = useRef(crypto.randomUUID())
  const submitIdemKeyRef = useRef(crypto.randomUUID())

  const [basics,       setBasics]       = useState<BasicsData | undefined>(draft && listingToBasics(draft.listing, draft.privateCategoryMetadata))
  const [pricing,      setPricing]      = useState<PricingData | undefined>(draft && listingToPricing(draft.listing))
  const [requirements, setRequirements] = useState<RequirementsData | undefined>(draft && { ...listingToRequirements(draft.listing, draft.requirements), deposit_amount: draft.requestedDepositAmount ?? draft.listing.deposit_amount ?? undefined })
  const [affiliates,   setAffiliates]   = useState<AffiliatesData | undefined>(draft && listingToAffiliates(draft.listing))
  const [photos,       setPhotos]       = useState<File[]>([])
  const [ownershipFile, setOwnershipFile] = useState<File | null>(null)
  const [conditionConfirmed, setConditionConfirmed] = useState(draft?.listing.condition_confirmed ?? false)
  const [knownDefects, setKnownDefects] = useState(draft?.listing.known_defects ?? '')
  const [hasDamagePhoto, setHasDamagePhoto] = useState(false)
  const [acceptedDeclarations, setAcceptedDeclarations] = useState<Set<string>>(new Set())
  const [blockedRanges, setBlockedRanges] = useState<BlockedDateRange[]>(
    (draft?.availability ?? []).map((a) => ({ start_date: a.start_date, end_date: a.end_date, reason: a.reason ?? undefined }))
  )

  // Existing media (edit mode) is mutable state, not a derived constant —
  // the merchant can remove, reorder, and re-mark the primary image before
  // saving. Removing an existing photo/ownership-proof schedules its
  // Storage object for deletion (processed only after a successful save —
  // see persistDraft — so a failed save never leaves a removed-but-not-
  // saved inconsistency).
  const [existingPhotos, setExistingPhotos] = useState(
    (draft?.listing.media ?? []).filter((m) => m.type === 'photo').sort((a, b) => a.display_order - b.display_order)
  )
  const [existingOwnershipUrl, setExistingOwnershipUrl] = useState(
    (draft?.listing.media ?? []).find((m) => m.type === 'ownership_proof')?.url ?? null
  )
  const [pendingStorageRemovals, setPendingStorageRemovals] = useState<{ bucket: 'listing-media' | 'ownership-proofs'; path: string }[]>([])

  const [listingId, setListingId] = useState<string | null>(draft?.listing.id ?? null)
  const [listingType, setListingType] = useState<ListingType>(draft?.listing.listing_type ?? 'rental')

  // 'requirements' (deposit/renter criteria) only applies when the item
  // can be rented — skipped entirely for a pure 'sale' listing.
  const steps = useMemo(
    () => BASE_STEPS.filter((s) => s.id !== 'requirements' || listingType !== 'sale'),
    [listingType]
  )
  const currentStep = steps[stepIdx]

  const goNext = () => setStepIdx((i) => Math.min(i + 1, steps.length - 1))
  const goBack = () => setStepIdx((i) => Math.max(i - 1, 0))

  const toggleDeclaration = (type: string) => {
    setAcceptedDeclarations((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type); else next.add(type)
      return next
    })
  }

  const removeExistingPhoto = (id: string) => {
    const target = existingPhotos.find((m) => m.id === id)
    setExistingPhotos(existingPhotos.filter((m) => m.id !== id))
    if (target) {
      // Scheduled, not immediate — actually deleted from Storage only
      // after the next successful save (see persistDraft), so a removal
      // that's never saved never touches Storage at all.
      const path = target.url.split('/listing-media/')[1] ?? target.url
      setPendingStorageRemovals((prev) => [...prev, { bucket: 'listing-media', path }])
    }
  }

  const replaceOwnershipFile = (f: File | null) => {
    if (f && existingOwnershipUrl) {
      setPendingStorageRemovals((prev) => [...prev, { bucket: 'ownership-proofs', path: existingOwnershipUrl }])
      setExistingOwnershipUrl(null)
    }
    setOwnershipFile(f)
  }

  /**
   * Uploads any newly-added local files to Storage, merges them with
   * whatever's already on record (edit mode), and POSTs the resulting
   * metadata + form state to /api/listings for the actual DB write. On
   * any failure after files were uploaded this attempt, best-effort
   * removes them so nothing orphaned is left in Storage. On success,
   * separately processes any pending removals (existing media the
   * merchant removed/replaced this session) — deferred until now so a
   * failed save never leaves a "removed but not saved" inconsistency.
   */
  const persistDraft = async (): Promise<string> => {
    if (!profile) throw new Error(t('review.errors.notSignedIn'))

    const uploadedThisAttempt: { bucket: 'listing-media' | 'ownership-proofs'; path: string }[] = []
    try {
      const newPhotoUploads = await Promise.all(
        photos.map(async (file) => {
          const res = await uploadListingPhoto(profile.id, file)
          uploadedThisAttempt.push({ bucket: 'listing-media', path: res.path })
          return res
        })
      )

      let ownershipUrl = existingOwnershipUrl
      if (ownershipFile) {
        const res = await uploadOwnershipProof(profile.id, ownershipFile)
        uploadedThisAttempt.push({ bucket: 'ownership-proofs', path: res.path })
        ownershipUrl = res.url
      }

      // Exactly one photo is primary: existing[0] if any exist, else
      // new[0]. Recomputed here (not trusted from prior state) so
      // reordering/removal always yields a consistent result.
      const media = [
        ...existingPhotos.map((m, i) => ({
          url: m.url,
          type: 'photo' as const,
          display_order: i,
          shot_type: i === 0 ? 'primary' as const : (m.shot_type === 'primary' ? undefined : m.shot_type ?? undefined),
        })),
        ...newPhotoUploads.map((u, i) => ({
          url: u.url,
          type: 'photo' as const,
          display_order: existingPhotos.length + i,
          shot_type: (existingPhotos.length === 0 && i === 0 ? 'primary' : hasDamagePhoto && i === newPhotoUploads.length - 1 ? 'damage_closeup' : undefined) as
            | 'primary' | 'damage_closeup' | undefined,
        })),
        ...(ownershipUrl ? [{ url: ownershipUrl, type: 'ownership_proof' as const, display_order: 0 }] : []),
      ]

      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listing_id: listingId,
          listing: {
            ...basics, ...pricing, ...affiliates,
            // Always sourced from state directly (not just the `...pricing`
            // spread) so an early draft-save — before the Pricing step has
            // even been reached — still persists the type chosen in the
            // very first step.
            listing_type: listingType,
            deposit_required: requirements?.deposit_required ?? false,
            deposit_amount: requirements?.deposit_amount,
            condition_confirmed: conditionConfirmed,
            known_defects: knownDefects || undefined,
          },
          requirements: { ...requirements },
          media,
          category_metadata: basics?.category_metadata ?? {},
          private_category_metadata: basics?.private_category_metadata ?? {},
          availability: blockedRanges,
          idempotency_key: saveIdemKeyRef.current,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? t('review.errors.couldNotSave'))

      // Success — rotate the key so the *next* save (e.g. after further
      // edits) is treated as a new logical action, not a replay of this one.
      saveIdemKeyRef.current = crypto.randomUUID()
      setListingId(body.listing_id)

      if (pendingStorageRemovals.length > 0) {
        await Promise.all(pendingStorageRemovals.map((p) => removeUploadedFiles(p.bucket, [p.path])))
        setPendingStorageRemovals([])
      }
      setPhotos([])
      setOwnershipFile(null)

      return body.listing_id as string
    } catch (err) {
      await Promise.all(uploadedThisAttempt.map((u) => removeUploadedFiles(u.bucket, [u.path])))
      throw err
    }
  }

  // If we arrived here mid-barter-proposal ("Create New Listing for This
  // Trade"), send the merchant back to that flow instead of the listings
  // dashboard — the barter dialog reads these same query params to
  // reopen and restore its previously-selected items (see
  // propose-trade-button.tsx / counter-offer-dialog.tsx). Reuses the
  // existing listing wizard completely unmodified otherwise (Decision 12
  // of the Barter Marketplace MVP Implementation Plan).
  function getPostSaveRedirect(): string {
    if (searchParams.get('returnTo') !== 'barter-propose') return '/dashboard/merchant/listings'
    const anchor = searchParams.get('anchor')
    const agreement = searchParams.get('agreement')
    if (agreement) return `/dashboard/barter/${agreement}?returnTo=barter-propose&agreement=${agreement}&counter=1`
    if (anchor) return `/listings/${anchor}?returnTo=barter-propose&anchor=${anchor}`
    return '/dashboard/merchant/listings'
  }

  const handleSaveDraft = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setSaving(true)
    setServerError('')
    try {
      await persistDraft()
      toast.success(t('toasts.draftSaved'))
      router.push(getPostSaveRedirect())
    } catch (err) {
      setServerError(err instanceof Error ? err.message : t('review.errors.couldNotSave'))
    } finally {
      setSaving(false)
      busyRef.current = false
    }
  }

  const handleSubmit = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setSubmitting(true)
    setServerError('')
    try {
      const id = await persistDraft()
      const res = await fetch(`/api/listings/${id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          declaration_types: Array.from(acceptedDeclarations),
          idempotency_key: submitIdemKeyRef.current,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        const issues = body.completeness?.blockingIssues as string[] | undefined
        throw new Error(issues?.length ? issues.join(' ') : (body.error ?? t('review.errors.couldNotSubmit')))
      }
      // Success — rotate for the same reason as the save key above.
      submitIdemKeyRef.current = crypto.randomUUID()
      toast.success(t('toasts.submitted'))
      router.push(getPostSaveRedirect())
    } catch (err) {
      setServerError(err instanceof Error ? err.message : t('review.errors.couldNotSubmit'))
    } finally {
      setSubmitting(false)
      busyRef.current = false
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('heading')}</h1>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">
          {t('stepProgress', { current: stepIdx + 1, total: steps.length, desc: t(`steps.${currentStep.id}.desc`) })}
        </p>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-1 mb-8 overflow-x-auto pb-1">
        {steps.map((step, i) => (
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
            }`}>{t(`steps.${step.id}.title`)}</span>
            {i < steps.length - 1 && (
              <div className={`h-px w-4 sm:w-6 transition-colors ${i < stepIdx ? 'bg-[#8B1A1A]' : 'bg-[#F2EDE8] dark:bg-[#2A1A1A]'}`} />
            )}
          </div>
        ))}
      </div>

      <div className="mb-6">
        <h2 className="text-lg font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">{t(`steps.${currentStep.id}.title`)}</h2>
      </div>

      {currentStep.id === 'type' && (
        <TypeStep onNext={(type) => { setListingType(type); goNext() }} defaults={listingType} />
      )}
      {currentStep.id === 'basics' && (
        <BasicsStep onNext={(d) => { setBasics(d); goNext() }} defaults={basics} />
      )}
      {currentStep.id === 'photos' && (
        <PhotosStep
          onNext={goNext}
          onBack={goBack}
          photos={photos}
          setPhotos={setPhotos}
          existingPhotos={existingPhotos}
          onRemoveExisting={removeExistingPhoto}
          onReorderExisting={setExistingPhotos}
          hasDeclaredDefects={knownDefects.trim().length > 0}
          hasDamagePhoto={hasDamagePhoto}
          setHasDamagePhoto={setHasDamagePhoto}
        />
      )}
      {currentStep.id === 'ownership' && (
        <OwnershipStep
          onNext={goNext}
          onBack={goBack}
          ownershipFile={ownershipFile}
          setOwnershipFile={replaceOwnershipFile}
          hasExistingOwnershipProof={!!existingOwnershipUrl}
          conditionConfirmed={conditionConfirmed}
          setConditionConfirmed={setConditionConfirmed}
          knownDefects={knownDefects}
          setKnownDefects={setKnownDefects}
        />
      )}
      {currentStep.id === 'pricing' && (
        <PricingStep
          onNext={(d) => { setPricing(d); goNext() }}
          onBack={goBack}
          defaults={pricing}
          blockedRanges={blockedRanges}
          setBlockedRanges={setBlockedRanges}
          listingType={listingType}
        />
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
        <AffiliatesStep onNext={(d) => { setAffiliates(d); goNext() }} onBack={goBack} defaults={affiliates} affiliateEnabled={affiliateEnabled} />
      )}
      {currentStep.id === 'review' && (
        <ReviewStep
          onBack={goBack}
          onSaveDraft={handleSaveDraft}
          onSubmit={handleSubmit}
          saving={saving}
          submitting={submitting}
          serverError={serverError}
          basics={basics}
          pricing={pricing}
          requirements={requirements}
          affiliates={affiliates}
          photoCount={existingPhotos.length + photos.length}
          ownershipFileName={ownershipFile?.name ?? ''}
          hasOwnershipProof={!!existingOwnershipUrl || !!ownershipFile}
          acceptedDeclarations={acceptedDeclarations}
          onToggleDeclaration={toggleDeclaration}
        />
      )}
    </div>
  )
}
