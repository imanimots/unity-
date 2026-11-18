# Secrets and Configuration Inventory

Built by grepping every `process.env.X` reference across `src/` and `scripts/` — a complete picture of every environment variable this codebase actually reads, not just the ones currently set in `.env.local`. No values are shown anywhere in this document, only names and classification. This closes the actionable half of Blocker #11 from the E46 register (enumerate every secret in use); the remaining half — confirming what's *actually deployed* on Vercel, as opposed to what the code merely *reads* — still needs access to the live deployment's environment variable configuration.

## Genuine secrets (rotation-worthy — compromise or leak is a real incident)

| Variable | Provider | What it protects | Rotation procedure |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Full read/write to every table, bypassing RLS — the single most sensitive credential in this system | Supabase Dashboard → Project Settings → API → regenerate. **Must be updated in the deployed environment simultaneously**, or every server route depending on it breaks immediately |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase | Client-side DB access (RLS-scoped) — public by design (`NEXT_PUBLIC_` prefix), but still rotatable if the project itself is compromised | Same dashboard location; lower urgency than the service-role key since RLS already bounds its blast radius |
| `CRON_SECRET` | Vercel (platform-fixed name) | Authorizes Vercel's own scheduled cron invocations | Vercel project settings; update both the dashboard value and any manual/curl invocation scripts that reference it |
| `INTERNAL_CRON_SECRET` | This project's own convention | Authorizes manual/non-Vercel cron invocations | Rotate by generating a new random value and updating the deployed env var |
| `ANTHROPIC_API_KEY` | Anthropic | The AI assistant's access to the Claude API | Anthropic Console → API Keys |
| `VOYAGE_API_KEY` | Voyage AI | Embedding generation for the Knowledge Base search | Voyage AI dashboard |
| `RESEND_API_KEY` | Resend | Transactional email sending | Resend dashboard |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash | Distributed rate-limiting | Upstash console — note the app degrades gracefully to in-memory rate limiting if this is wrong/missing, so a rotation mistake here is lower-severity than most others on this list |
| `PEACH_CARD_API_BACKOFFICE_BEARER_TOKEN` | Peach Payments | Card-API backoffice access | Peach Payments merchant portal |
| `PEACH_CARD_API_WEBHOOK_DECRYPTION_KEY` | Peach Payments | Decrypting incoming card-API webhook payloads | Same |
| `PEACH_CHECKOUT_WEBHOOK_SIGNING_SECRET` | Peach Payments | Verifying checkout webhook signatures | Same |
| `PEACH_ORCHESTRATION_API_KEY` | Peach Payments | Orchestration API access | Same |
| `PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY` | Peach Payments | Verifying payment-response integrity | Same |
| `PEACH_ORCHESTRATION_WEBHOOK_SECRET` | Peach Payments | Verifying orchestration webhook signatures | Same |
| `PEACH_PAYOUTS_API_BEARER_TOKEN` | Peach Payments | Payouts API access | Same |

**Rotating any payment-provider secret is itself the kind of action this programme's own execution rules require explicit approval for** ("Changing live payment, escrow, refund or payout configurations") — this table documents what exists and how to rotate it in principle; it does not authorize doing so.

## Identity/non-secret configuration values (used in comparisons, not as credentials, but still sensitive to leak)

| Variable | Why it's not a classic "secret" but still shouldn't be casually exposed |
|---|---|
| `GCP_SCHEDULER_SERVICE_ACCOUNT_SUB` | A service-account identifier the OIDC verifier compares against — leaking it alone doesn't grant access (the actual token is cryptographically signed by Google), but it does reveal which service account this project expects |
| `GCP_SCHEDULER_AUDIENCE_ORIGIN` | A trusted origin URL for OIDC audience validation — same reasoning |
| `QA_SEED_PROJECT_REF` | The project reference the QA seed script refuses to run against a mismatch for — a safety guard, not a credential |
| `QA_SEED_CONFIRM` | A fixed confirmation string (`UNITY_DEV_ONLY`) the seed script requires — a deliberate friction/safety gate, not a secret in the traditional sense |

## Feature flags and plain configuration (not secrets at all — listed for completeness, not because they need rotation)

`ADMIN_MFA_ENFORCED`, `ADVERTISING_BILLING_PROVIDER`, `ADVERTISING_ENABLED`, `ANTHROPIC_MODEL`, `BARTER_PROPOSAL_EXPIRY_HOURS`, `BOOKING_PAYMENT_DEADLINE_HOURS`, `EMAIL_FROM_ADDRESS`, `EMAIL_PROVIDER`, `EMAIL_REPLY_TO`, `ESCROW_ENABLED`, `ESCROW_PROVIDER`, `IDENTITY_VERIFICATION_PROVIDER`, `MERCHANT_AI_ASSISTANT_ENABLED`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_DEFAULT_COUNTRY`, `NEXT_PUBLIC_MOCK_MODE`, `NEXT_PUBLIC_PAYMENT_MODE`, `NEXT_PUBLIC_SUPABASE_URL` (public by design), `NEXT_PUBLIC_WARP_AFFILIATE_URL`, `NODE_ENV`, `OWNERSHIP_VERIFICATION_PROVIDER`, `PAYMENT_PROVIDER`, `PAYMENT_REMINDER_HOURS_BEFORE_DUE`, `PEACH_CHECKOUT_ENTITY_ID`, `PEACH_CHECKOUT_WEBHOOK_URL`, `PEACH_ENVIRONMENT`, `PEACH_ORCHESTRATION_API_BASE_URL`, `PEACH_ORCHESTRATION_ENVIRONMENT`, `PERSONALIZATION_ENABLED`, `QA_RUN_ID`, `QA_SEED_ENABLED`, `RENT_TO_BUY_ENABLED`, `SEO_INDEXING_ENABLED`, `SEO_MARKETPLACE_INDEXING_ENABLED`, `SUBSCRIPTION_BILLING_PROVIDER`. (`NEXT_RUNTIME`, `VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` are platform-injected by Next.js/Vercel themselves, never set manually.)

## What this inventory does NOT close

- **Which of these are actually set in the live Vercel deployment, as opposed to merely read by the code** — that requires Vercel dashboard/CLI access this session doesn't have. A variable appearing in this list means the code has a code path that reads it; it does not confirm a real value is configured anywhere live.
- **Whether any payment-provider secret has ever actually been issued for a real (non-sandbox) Peach Payments account** — this project's standing policy throughout its entire history has been sandbox-only, consistent with "no real money" — so many of the Peach-related secrets above may have no real counterpart yet at all.
