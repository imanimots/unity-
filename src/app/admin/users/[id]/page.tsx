'use client'

import { use } from 'react'
import { Customer360 } from '@/components/admin/customer-360'

/** Customer 360 -- a persistent detail route alongside (not replacing) the existing /admin/users list + slide-over. ADMIN-CONTROL-CENTRE-BATCH-A1. */
export default function AdminCustomer360Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <Customer360 userId={id} mode="customer" />
}
