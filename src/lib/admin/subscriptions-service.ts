import type { SupabaseClient } from '@supabase/supabase-js'
import { getEffectiveMerchantPlan } from '@/lib/subscriptions/effective-plan'
import { getPublicationUsage } from '@/lib/subscriptions/entitlements'
import { classifyProfile } from '@/lib/admin/data-scope'

const DEFAULT_LIMIT = 100

export interface AdminSubscriptionRow {
  merchantId: string
  merchantName: string | null
  currentPlanId: string
  status: string
  pendingPlanId: string | null
  pendingPlanEffectiveAt: string | null
  lastTransitionCategory: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminSubscriptionFilters {
  status?: string
  planId?: string
  search?: string
  limit?: number
}

/**
 * Mirrors listAdminOrders/listAdminBarterAgreements' exact shape. Lists
 * merchant_subscriptions rows only -- a merchant who has never changed
 * plan away from the implicit Starter default has no row here by
 * design (see effective-plan.ts's header comment); look them up
 * individually via getAdminSubscriptionDetail(), which resolves any
 * merchant id to Starter when no row exists.
 */
/**
 * D3-E: real requires the authoritative merchant profile
 * (merchant_subscriptions.merchant_id -> profiles.id, FK
 * `merchant_subscriptions_merchant_id_fkey`) positively real. No
 * entity-level is_test column exists on merchant_subscriptions.
 * Scoped at the database level via an inner-joined profile, before
 * `.limit()`.
 */
export async function listAdminSubscriptions(admin: SupabaseClient, filters: AdminSubscriptionFilters): Promise<AdminSubscriptionRow[]> {
  let query = admin
    .from('merchant_subscriptions')
    .select(
      'merchant_id, current_plan_id, status, pending_plan_id, pending_plan_effective_at, last_transition_category, created_at, updated_at, profiles!merchant_subscriptions_merchant_id_fkey!inner(data_classification)'
    )
    .eq('profiles.data_classification', 'real')
    .order('updated_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.planId && filters.planId !== 'all') query = query.eq('current_plan_id', filters.planId)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const merchantIds = rows.map((r) => r.merchant_id)
  const { data: profiles } = await admin.from('profiles').select('id, full_name, display_name').in('id', merchantIds)
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))

  let results: AdminSubscriptionRow[] = rows.map((r) => ({
    merchantId: r.merchant_id,
    merchantName: nameById.get(r.merchant_id) ?? null,
    currentPlanId: r.current_plan_id,
    status: r.status,
    pendingPlanId: r.pending_plan_id,
    pendingPlanEffectiveAt: r.pending_plan_effective_at,
    lastTransitionCategory: r.last_transition_category,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter((r) => (r.merchantName ?? '').toLowerCase().includes(q) || r.merchantId.toLowerCase().includes(q))
  }

  return results
}

export interface AdminSubscriptionDetail {
  merchant: { id: string; name: string | null; accountStatus: string | null }
  effectivePlanId: string
  effectivePlan: { id: string; displayName: string; monthlyFeeCents: number; salesCommissionBps: number; rentalCommissionBps: number; barterCommissionBps: number } | null
  subscription: {
    currentPlanId: string
    currentPlanEffectiveAt: string
    pendingPlanId: string | null
    pendingPlanEffectiveAt: string | null
    status: string
    lastTransitionCategory: string | null
  } | null
  listingUsage: { activeCount: number; limit: number | null; atLimit: boolean }
  history: Array<{
    id: string
    previousPlanId: string | null
    newPlanId: string
    requestedAt: string
    effectiveAt: string
    actorType: string
    actorId: string | null
    changeCategory: string
    reason: string | null
  }>
  billingAttempts: Array<{ id: string; planId: string; amountCents: number; status: string; providerReference: string | null; failureReason: string | null; createdAt: string }>
}

/**
 * Root profile lookup + Promise.all of children, mirroring
 * getAdminOrderDetail's exact shape. Resolves any merchant id (even one
 * that has never had a merchant_subscriptions row) via
 * getEffectiveMerchantPlan(), so an admin can look up and correct a
 * Starter-by-default merchant's plan too.
 */
export async function getAdminSubscriptionDetail(admin: SupabaseClient, merchantId: string): Promise<AdminSubscriptionDetail | null> {
  const { data: profile } = await admin.from('profiles').select('id, full_name, display_name, account_status, data_classification').eq('id', merchantId).maybeSingle()
  if (!profile) return null
  // D3-E: a known test/unknown-classified merchant id must not load as
  // an ordinary Real Data subscription detail -- checked before the
  // plan/usage/history/billing fetches below.
  if (classifyProfile(profile) !== 'real') return null

  const [{ planId, plan, subscription }, listingUsage, { data: historyRows }, { data: billingRows }] = await Promise.all([
    getEffectiveMerchantPlan(admin, merchantId),
    getPublicationUsage(admin, merchantId),
    admin
      .from('merchant_subscription_history')
      .select('id, previous_plan_id, new_plan_id, requested_at, effective_at, actor_type, actor_id, change_category, reason')
      .eq('merchant_id', merchantId)
      .order('requested_at', { ascending: false }),
    admin
      .from('merchant_subscription_billing_attempts')
      .select('id, plan_id, amount_cents, status, provider_reference, failure_reason, created_at')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false }),
  ])

  return {
    merchant: { id: profile.id, name: profile.full_name ?? profile.display_name ?? null, accountStatus: profile.account_status },
    effectivePlanId: planId,
    effectivePlan: plan
      ? {
          id: plan.id,
          displayName: plan.display_name,
          monthlyFeeCents: plan.monthly_fee_cents,
          salesCommissionBps: plan.sales_commission_bps,
          rentalCommissionBps: plan.rental_commission_bps,
          barterCommissionBps: plan.barter_commission_bps,
        }
      : null,
    subscription: subscription
      ? {
          currentPlanId: subscription.current_plan_id,
          currentPlanEffectiveAt: subscription.current_plan_effective_at,
          pendingPlanId: subscription.pending_plan_id,
          pendingPlanEffectiveAt: subscription.pending_plan_effective_at,
          status: subscription.status,
          lastTransitionCategory: subscription.last_transition_category,
        }
      : null,
    listingUsage: { activeCount: listingUsage.activeCount, limit: listingUsage.limit, atLimit: listingUsage.atLimit },
    history: (historyRows ?? []).map((h) => ({
      id: h.id,
      previousPlanId: h.previous_plan_id,
      newPlanId: h.new_plan_id,
      requestedAt: h.requested_at,
      effectiveAt: h.effective_at,
      actorType: h.actor_type,
      actorId: h.actor_id,
      changeCategory: h.change_category,
      reason: h.reason,
    })),
    billingAttempts: (billingRows ?? []).map((b) => ({
      id: b.id,
      planId: b.plan_id,
      amountCents: b.amount_cents,
      status: b.status,
      providerReference: b.provider_reference,
      failureReason: b.failure_reason,
      createdAt: b.created_at,
    })),
  }
}

const CSV_COLUMNS: (keyof AdminSubscriptionRow)[] = [
  'merchantName',
  'currentPlanId',
  'status',
  'pendingPlanId',
  'pendingPlanEffectiveAt',
  'lastTransitionCategory',
  'updatedAt',
]

export async function exportAdminSubscriptionsCsv(admin: SupabaseClient, filters: AdminSubscriptionFilters): Promise<AdminSubscriptionRow[]> {
  return listAdminSubscriptions(admin, filters)
}

export const SUBSCRIPTION_CSV_COLUMNS = CSV_COLUMNS

export interface RealSubscriptionOverviewCounts {
  merchantSubscriptionsPro: number
  merchantSubscriptionsElite: number
  merchantSubscriptionsPendingChange: number
  merchantSubscriptionsCancelled: number
  merchantSubscriptionsDueForReversion: number
}

/**
 * D3-E: the 5 merchant-subscription-derived Admin Overview metrics,
 * scoped to confirmed real merchants only -- the exact same rule
 * listAdminSubscriptions already applies. Preserves every existing
 * status/plan/timestamp definition from get_admin_overview_stats()
 * verbatim.
 */
export async function getRealSubscriptionOverviewCounts(admin: SupabaseClient): Promise<RealSubscriptionOverviewCounts> {
  const scoped = () =>
    admin
      .from('merchant_subscriptions')
      .select('merchant_id, profiles!merchant_subscriptions_merchant_id_fkey!inner(data_classification)', { count: 'exact', head: true })
      .eq('profiles.data_classification', 'real')

  const [
    { count: merchantSubscriptionsPro },
    { count: merchantSubscriptionsElite },
    { count: merchantSubscriptionsPendingChange },
    { count: merchantSubscriptionsCancelled },
    { count: merchantSubscriptionsDueForReversion },
  ] = await Promise.all([
    scoped().eq('current_plan_id', 'pro'),
    scoped().eq('current_plan_id', 'elite'),
    scoped().eq('status', 'pending_change'),
    scoped().eq('status', 'cancelled'),
    scoped().in('status', ['pending_change', 'cancelled']).lte('pending_plan_effective_at', new Date().toISOString()),
  ])

  return {
    merchantSubscriptionsPro: merchantSubscriptionsPro ?? 0,
    merchantSubscriptionsElite: merchantSubscriptionsElite ?? 0,
    merchantSubscriptionsPendingChange: merchantSubscriptionsPendingChange ?? 0,
    merchantSubscriptionsCancelled: merchantSubscriptionsCancelled ?? 0,
    merchantSubscriptionsDueForReversion: merchantSubscriptionsDueForReversion ?? 0,
  }
}
