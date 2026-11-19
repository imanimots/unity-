/**
 * E49 Phase 3 item 11: "Introduce configuration validation that rejects
 * unsafe environment combinations." Deliberately a genuine no-op today
 * -- there is only one Supabase project in existence right now
 * (confirmed via this programme's own live read-only audit), so there
 * is nothing yet to separate. This check activates itself the moment
 * PRODUCTION_SUPABASE_PROJECT_REF is actually set -- the signal that a
 * real, separate production project now exists -- and from that point
 * on enforces, in both directions:
 *   - a production deployment (VERCEL_ENV === 'production') must point
 *     at the designated production project, never the dev/staging one.
 *   - a non-production deployment (local dev, preview, anything else)
 *     must NOT point at the designated production project.
 *
 * Pure function (no process.env reads inside) so it's trivially unit
 * tested without env-stubbing gymnastics; validateEnvironmentSeparation()
 * below is the thin process.env-reading wrapper actually called from
 * next.config.ts.
 */

export interface EnvironmentSeparationCheck {
  safe: boolean
  reason?: string
}

export function checkEnvironmentSeparation(params: {
  supabaseUrl: string | undefined
  vercelEnv: string | undefined
  productionProjectRef: string | undefined
}): EnvironmentSeparationCheck {
  const { supabaseUrl, vercelEnv, productionProjectRef } = params

  // Nothing to enforce yet -- only one Supabase project exists until
  // this is set. Never throws, never warns -- a genuinely empty
  // configuration is not a misconfiguration.
  if (!productionProjectRef) return { safe: true }

  const pointsAtDesignatedProduction = Boolean(supabaseUrl?.includes(productionProjectRef))
  const isProductionDeployment = vercelEnv === 'production'

  if (isProductionDeployment && !pointsAtDesignatedProduction) {
    return {
      safe: false,
      reason:
        'VERCEL_ENV=production but NEXT_PUBLIC_SUPABASE_URL does not match PRODUCTION_SUPABASE_PROJECT_REF -- ' +
        'a production deployment is about to run against the wrong Supabase project.',
    }
  }

  if (!isProductionDeployment && pointsAtDesignatedProduction) {
    return {
      safe: false,
      reason:
        'VERCEL_ENV is not production, but NEXT_PUBLIC_SUPABASE_URL matches PRODUCTION_SUPABASE_PROJECT_REF -- ' +
        'a non-production deployment (local dev, preview, or similar) is about to run against the live production database.',
    }
  }

  return { safe: true }
}

/** The actual integration point -- reads process.env, throws on an unsafe combination. Called once from next.config.ts at build/start time. */
export function validateEnvironmentSeparation(): void {
  const result = checkEnvironmentSeparation({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    vercelEnv: process.env.VERCEL_ENV,
    productionProjectRef: process.env.PRODUCTION_SUPABASE_PROJECT_REF,
  })
  if (!result.safe) {
    throw new Error(`[environment-separation] Refusing to start: ${result.reason}`)
  }
}
