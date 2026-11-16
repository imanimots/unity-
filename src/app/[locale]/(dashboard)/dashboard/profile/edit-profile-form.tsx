'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'

interface EditProfileButtonProps {
  currentDisplayName: string
}

/** Real, narrow edit action -- PATCHes the one display_name column that
 * actually exists and is actually editable (see /api/profile/display-name).
 * No avatar upload here: that needs Supabase Storage wiring this phase
 * deliberately doesn't add (E47 is presentation-layer only). */
export function EditProfileButton({ currentDisplayName }: EditProfileButtonProps) {
  const t = useTranslations('account.profilePage')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(currentDisplayName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/profile/display-name', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name.trim() }),
      })
      if (!res.ok) throw new Error('failed')
      setOpen(false)
      router.refresh()
    } catch {
      setError(t('updateFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        onClick={() => { setName(currentDisplayName); setOpen(true) }}
        className="px-4 py-2 rounded-lg border border-[#F2EDE8] text-sm font-semibold text-[#1A0A0A] hover:bg-[#F2EDE8] transition-colors"
      >
        {t('editProfile')}
      </button>

      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => !saving && setOpen(false)} />
          <div className="relative bg-white rounded-2xl border border-[#F2EDE8] p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-[#1A0A0A]">{t('editProfileTitle')}</h2>
              <button onClick={() => setOpen(false)} className="text-[#9B8B85] hover:text-[#1A0A0A]">
                <X size={18} />
              </button>
            </div>
            <label className="block text-xs font-semibold text-[#6B5B55] mb-1.5">{t('displayNameLabel')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="w-full h-11 px-3 rounded-lg border border-[#E8E0D8] text-sm text-[#1A0A0A] focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30 focus:border-[#8B1A1A]"
            />
            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setOpen(false)}
                disabled={saving}
                className="flex-1 py-2.5 rounded-lg border border-[#F2EDE8] text-sm font-semibold text-[#1A0A0A] hover:bg-[#F2EDE8] transition-colors disabled:opacity-50"
              >
                {t('cancel')}
              </button>
              <button
                onClick={save}
                disabled={saving || !name.trim()}
                className="flex-1 py-2.5 rounded-lg bg-[#8B1A1A] text-white text-sm font-semibold hover:bg-[#7A1616] transition-colors disabled:opacity-50"
              >
                {saving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
