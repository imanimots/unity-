import type { SupabaseClient } from '@supabase/supabase-js'
import type { MerchantAiCapability, MerchantAiResult } from './types'

/**
 * Minimal safe usage/audit record (Section 40) -- no prompt/response
 * text persisted here, ever. Failing to record usage must never break
 * the actual assistant response, so this is deliberately fire-and-log,
 * matching every other best-effort telemetry call in this codebase
 * (e.g. notifyMerchantSubscriptionEvent's own try/catch convention).
 */
export async function recordMerchantAiUsage(
  supabase: SupabaseClient,
  merchantId: string,
  planId: string,
  capability: MerchantAiCapability,
  result: MerchantAiResult,
  provider: string
): Promise<void> {
  try {
    await supabase.rpc('record_merchant_ai_usage_event', {
      p_merchant_id: merchantId,
      p_plan_id: planId,
      p_capability: capability,
      p_status: result.status,
      p_provider: provider,
      p_model: result.model ?? null,
      p_input_tokens: result.inputTokens ?? null,
      p_output_tokens: result.outputTokens ?? null,
      p_latency_ms: result.latencyMs ?? null,
    })
  } catch (err) {
    console.error('[merchant-ai.usage] failed to record usage event', { merchantId, capability, err })
  }
}
