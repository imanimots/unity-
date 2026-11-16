export type UnityCommissionStatus = 'pending' | 'held' | 'earned' | 'adjusted' | 'voided'

export const UNITY_COMMISSION_STATUS_LABELS: Record<UnityCommissionStatus, { label: string; classes: string }> = {
  pending: { label: 'Pending', classes: 'bg-amber-100 text-amber-700' },
  held: { label: 'Held', classes: 'bg-red-100 text-red-700' },
  earned: { label: 'Earned', classes: 'bg-green-100 text-green-700' },
  adjusted: { label: 'Adjusted', classes: 'bg-blue-100 text-blue-700' },
  voided: { label: 'Voided', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
}
