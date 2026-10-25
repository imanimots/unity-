'use client'

import { use } from 'react'
import { Customer360 } from '@/components/admin/customer-360'

/** Merchant 360 -- reuses the Customer 360 component (a merchant is a profile/user with role='merchant'|'both', not a separate data model). ADMIN-CONTROL-CENTRE-BATCH-A1. */
export default function AdminMerchant360Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <Customer360 userId={id} mode="merchant" />
}
