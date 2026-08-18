import { useTranslations } from 'next-intl'

/**
 * Single source of truth for Skill/Task/Available/Looking-For display
 * labels — consolidates the "kind === 'skill' ? 'Skill' : 'Task'" /
 * "direction === 'available' ? 'Available' : 'Looking For'" ternary that
 * the i18n audit found independently duplicated across 8 files. Call sites
 * should import this hook instead of re-deriving the label inline, so the
 * glossary term (docs/I18N_GLOSSARY.md) stays consistent everywhere rather
 * than drifting per file.
 */
export function useSkillTaskLabels() {
  const tSkills = useTranslations('skills')
  const tTasks = useTranslations('tasks')
  const tMarketplace = useTranslations('marketplace')

  return {
    kindLabel(kind: 'skill' | 'task'): string {
      return kind === 'skill' ? tSkills('label') : tTasks('label')
    },
    directionLabel(direction: 'available' | 'looking_for'): string {
      return direction === 'available' ? tMarketplace('direction.available') : tMarketplace('direction.lookingFor')
    },
    summary(kind: 'skill' | 'task', direction: 'available' | 'looking_for'): string {
      const ns = kind === 'skill' ? tSkills : tTasks
      return direction === 'available' ? ns('available.summary') : ns('lookingFor.summary')
    },
  }
}
