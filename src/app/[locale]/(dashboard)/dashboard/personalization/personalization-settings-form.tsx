'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { CATEGORIES } from '@/types'
import { clearAnonymousHistory } from '@/lib/personalization/anonymous'
import type { PersonalizationKind, PersonalizationMode } from '@/lib/personalization/types'

interface SettingsPayload {
  personalizationEnabled: boolean
  preferredModes: PersonalizationMode[]
  preferredCategories: string[]
  preferredBarterKinds: PersonalizationKind[]
  interestedLookingFor: boolean
  interestedRtb: boolean
  preferredProvince: string | null
  preferredCity: string | null
}

const MODES: PersonalizationMode[] = ['buy', 'rent', 'barter']
const KINDS: PersonalizationKind[] = ['item', 'skill', 'task']

function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
}

export function PersonalizationSettingsForm() {
  const t = useTranslations('personalization.settings')
  const tCategories = useTranslations('common.categories')
  const [settings, setSettings] = useState<SettingsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearedMessage, setClearedMessage] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/personalization/settings')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setSettings(data.settings)
    } catch {
      setError(t('errors.couldNotLoad'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  async function save(next: SettingsPayload) {
    setSettings(next)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/personalization/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!res.ok) throw new Error()
      setSavedAt(Date.now())
    } catch {
      setError(t('errors.couldNotSave'))
    } finally {
      setSaving(false)
    }
  }

  async function clearHistory() {
    setClearing(true)
    setError(null)
    try {
      const res = await fetch('/api/personalization/reset', { method: 'POST' })
      if (!res.ok) throw new Error()
      clearAnonymousHistory()
      setClearedMessage(true)
      setConfirmingClear(false)
    } catch {
      setError(t('errors.couldNotClear'))
    } finally {
      setClearing(false)
    }
  }

  if (loading) return <p className="text-sm text-[#9B8B85]">…</p>
  if (!settings) return <p className="text-sm text-red-600 dark:text-red-400">{error ?? t('errors.couldNotLoad')}</p>

  return (
    <div className="space-y-8">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center justify-between p-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
        <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('enabledLabel')}</span>
        <button
          type="button"
          onClick={() => save({ ...settings, personalizationEnabled: !settings.personalizationEnabled })}
          className={`px-4 py-1.5 rounded-full text-xs font-semibold uppercase tracking-[0.08em] transition-colors ${
            settings.personalizationEnabled ? 'bg-[#8B1A1A] text-white' : 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]'
          }`}
        >
          {settings.personalizationEnabled ? t('enabledOn') : t('enabledOff')}
        </button>
      </div>
      {!settings.personalizationEnabled && <p className="text-xs text-[#9B8B85]">{t('disabledNotice')}</p>}

      <div>
        <h2 className="text-sm font-bold uppercase tracking-[0.08em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-4">{t('interestsHeading')}</h2>

        <div className="mb-5">
          <p className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-2">{t('modesLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => save({ ...settings, preferredModes: toggleInArray(settings.preferredModes, mode) })}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  settings.preferredModes.includes(mode)
                    ? 'bg-[#8B1A1A] text-white'
                    : 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]'
                }`}
              >
                {mode === 'buy' ? t('modeBuy') : mode === 'rent' ? t('modeRent') : t('modeBarter')}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-5">
          <p className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-2">{t('categoriesLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => save({ ...settings, preferredCategories: toggleInArray(settings.preferredCategories, category.id) })}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  settings.preferredCategories.includes(category.id)
                    ? 'bg-[#8B1A1A] text-white'
                    : 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]'
                }`}
              >
                {tCategories(category.id)}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-5">
          <p className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-2">{t('barterKindsLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => save({ ...settings, preferredBarterKinds: toggleInArray(settings.preferredBarterKinds, kind) })}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  settings.preferredBarterKinds.includes(kind)
                    ? 'bg-[#8B1A1A] text-white'
                    : 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]'
                }`}
              >
                {kind === 'item' ? t('kindItem') : kind === 'skill' ? t('kindSkill') : t('kindTask')}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">
          <input
            type="checkbox"
            checked={settings.interestedLookingFor}
            onChange={(e) => save({ ...settings, interestedLookingFor: e.target.checked })}
          />
          {t('lookingForLabel')}
        </label>
        <label className="flex items-center gap-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          <input type="checkbox" checked={settings.interestedRtb} onChange={(e) => save({ ...settings, interestedRtb: e.target.checked })} />
          {t('rtbLabel')}
        </label>
      </div>

      <div>
        <h2 className="text-sm font-bold uppercase tracking-[0.08em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-4">{t('locationHeading')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">{t('provinceLabel')}</label>
            <input
              defaultValue={settings.preferredProvince ?? ''}
              placeholder={t('provincePlaceholder')}
              onBlur={(e) => save({ ...settings, preferredProvince: e.target.value || null })}
              className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">{t('cityLabel')}</label>
            <input
              defaultValue={settings.preferredCity ?? ''}
              placeholder={t('cityPlaceholder')}
              onBlur={(e) => save({ ...settings, preferredCity: e.target.value || null })}
              className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm"
            />
          </div>
        </div>
      </div>

      {saving && <p className="text-xs text-[#9B8B85]">{t('saving')}</p>}
      {!saving && savedAt && <p className="text-xs text-green-700 dark:text-green-400">{t('saved')}</p>}

      <div className="pt-6 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
        <h2 className="text-sm font-bold uppercase tracking-[0.08em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('activityHeading')}</h2>
        <p className="text-xs text-[#9B8B85] mb-3">{t('clearHistoryDesc')}</p>

        {!confirmingClear ? (
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
          >
            {t('clearHistoryButton')}
          </button>
        ) : (
          <div className="p-4 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A]">
            <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1">{t('clearHistoryConfirmTitle')}</p>
            <p className="text-xs text-[#9B8B85] mb-3">{t('clearHistoryConfirmDesc')}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={clearHistory}
                disabled={clearing}
                className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors disabled:opacity-50"
              >
                {t('clearHistoryConfirm')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingClear(false)}
                className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
              >
                {t('cancelButton')}
              </button>
            </div>
          </div>
        )}
        {clearedMessage && <p className="text-xs text-green-700 dark:text-green-400 mt-2">{t('clearHistorySuccess')}</p>}
      </div>
    </div>
  )
}
