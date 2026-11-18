# Pillar C — Threat/Control Matrix (OWASP ASVS 5.0-aligned) & POPIA

No invasive or destructive testing was performed. All findings are from static code/config review. Live infrastructure settings (Supabase dashboard MFA policy, WAF, incident history, actual encryption-at-rest configuration) are explicitly out of reach from code and are labeled NOT VERIFIED rather than assumed.

## ASVS V1 — Encoding & Sanitization / V5 — Validation

| Control | Status | Evidence | Risk if gap |
|---|---|---|---|
| Upload MIME/size validation | **VERIFIED** | `src/lib/listings/storage.ts:38-56` (`validatePhotoFile`, `validateOwnershipProofFile`) | — |
| Path-traversal protection on uploaded filenames | **VERIFIED** | `storage.ts:23-27` (`sanitizedExtension()` strips to alphanumeric only) | — |
| Malware/virus scanning of uploads | **ABSENT** | Exhaustive grep for "clamav"/"virus"/"malware scan" — zero hits | Medium-High: a malicious file could be stored and later served, including from the **public** `listing-media` bucket |
| Zod schema validation on API input | **VERIFIED (broadly)** | Confirmed pattern on analytics ingestion (`src/lib/analytics/validation.ts:16-55`), listing drafts, and others reviewed in this pass | — |

## ASVS V2 — Authentication

| Control | Status | Evidence | Risk if gap |
|---|---|---|---|
| Session-cookie-based auth via Supabase Auth | **VERIFIED** | `src/lib/supabase/{client,server}.ts` via `@supabase/ssr` | — |
| Password strength policy | **NOT VERIFIED FROM CODE** | No app-level strength validation found; Supabase dashboard-level policy is a project setting not in this repo | Password policy could be weaker than intended without a dashboard check |
| MFA for admin accounts | **ABSENT (app-enforced)** | `requireAdmin()` (`src/lib/supabase/require-admin.ts:59-67`) checks only `profile.role === 'admin'` — no AAL/MFA gate. Admin UI only has *read-only visibility* into a user's enrolled factor count (`src/lib/supabase/admin-auth-info.ts:14-15,67,80-81`), never enforces one. | **High** — full admin panel (KYC approval, financial records, user suspension) is reachable with a password alone |
| Failed-login-attempt tracking | **ABSENT, and explicitly documented as such in code** | `admin-auth-info.ts:46-50`: "a failed-login attempt count... Never fabricate" — UI renders `AUTH_FIELD_NOT_AVAILABLE` | Medium — no detection signal for credential-stuffing/brute-force |

## ASVS V3/V4 — Session Management & Access Control

| Control | Status | Evidence | Risk if gap |
|---|---|---|---|
| Server-side role derivation (never trust client-supplied role) | **VERIFIED** | `require-admin.ts:16-46,59-96` — role always re-fetched from `profiles` keyed by `auth.uid()`; zero API routes found reading a client-supplied "role" field for authorization | — |
| RBAC: admin/merchant/renter separation | **VERIFIED** | `requireAdmin()`/`requireMerchant()`/`requireAuth()`, same file | — |
| Row-Level Security coverage | **VERIFIED, broad** | 270 `create policy` statements across 265 migrations (`grep -c "create policy"` summed) | — |
| Tenant isolation (no dangerous `using(true)` on sensitive tables) | **VERIFIED** | Every `using(true)`/`with check(true)` hit found is public reference/catalog data (countries, listing_media display, reviews display, categories, bank-name reference list). One historical over-permissive `profiles` policy existed and was already remediated by a dedicated migration + restricted `public_profiles` view (`20260831000001_profiles_privacy_boundary.sql`). | Low (closed finding — included here as evidence of how this codebase has historically handled a real RLS vulnerability, not as a current gap) |
| Privilege-escalation history | **VERIFIED, closed** | `20260729000001_fix_rls_privilege_escalation.sql:130-133` — a prior `bookings` UPDATE policy gap was tightened with an explicit `WITH CHECK` clause | Low (same note as above) |

## ASVS V9 — Communications / Webhook integrity

| Control | Status | Evidence | Risk if gap |
|---|---|---|---|
| Webhook signature verification (payments, escrow, payouts) | **VERIFIED, all 4 routes** | `src/app/api/escrow/webhooks/[provider]/route.ts:50`, `src/app/api/payments/webhooks/[provider]/route.ts:121,221`, `.../peach-payouts/route.ts:50`, `.../peach-banv/route.ts:63` — every route verifies signature/HMAC before trusting payload, rejects with 401, and records `signature_valid` for audit | — |
| Mock-provider isolation in production | **VERIFIED** | `[provider]/route.ts:57-66` explicitly blocks a hardcoded mock signature from being accepted in production | — |

## ASVS V11 — Business Logic / Rate Limiting

| Control | Status | Evidence | Risk if gap |
|---|---|---|---|
| Rate limiting mechanism | **VERIFIED** | Upstash Redis-backed, atomic `INCR`+`EXPIRE`, SHA-256-hashed IP keys (no raw IP persisted) — `src/lib/rate-limit-distributed-adapter.ts:28-58,82-83` | — |
| Fail-safe behavior on rate-limiter outage | **VERIFIED** | Falls back to in-memory limiter, never to "no limit" (`rate-limit-memory-adapter.ts:22-42`, comments `distributed-adapter.ts:21-25,98-104`) | — |
| Exact per-route limits on login/payment/admin-mutation routes | **NOT INDEPENDENTLY RE-VERIFIED** | A code comment claims "80+ call sites" mechanically updated — individual thresholds on the most sensitive routes were not re-opened in this pass | Should be spot-checked before relying on this scorecard for those specific routes |

## ASVS V7 — Error Handling / Logging & V17 — WebRTC/Monitoring-adjacent

| Control | Status | Evidence | Risk if gap |
|---|---|---|---|
| Admin mutation audit trail | **VERIFIED** | `src/lib/admin/audit-service.ts:1-89` unifies 3 immutable history tables; logs who/what/when for status-changing admin actions | — |
| Admin **read** access logging (KYC docs, financial records) | **ABSENT** | No "viewed" action-type found anywhere in identity-verification or payout-destination RPCs | Medium-High — undetectable insider access to sensitive records |
| External error monitoring/alerting (Sentry/Datadog/PagerDuty) | **ABSENT** | Zero hits across package.json and src/ | High — production failures, including security-relevant ones, may go unnoticed |

## ASVS V6 — Cryptography / Secrets

| Control | Status | Evidence | Risk if gap |
|---|---|---|---|
| Secrets never committed to the repo | **VERIFIED** | `.gitignore:37-38` ignores `.env*`; exhaustive grep for hardcoded-looking key/secret patterns found zero genuine hits | — |
| Field-level encryption of financial account numbers | **VERIFIED** | Bank account numbers stored via Supabase Vault (`vault.create_secret`), only last-4 digits in plaintext; decrypt RPC is `service_role`-only (`20261111184936_...sql:459,509-533`) | — |
| Field-level encryption of national ID/passport numbers | **ABSENT** | No equivalent Vault/encryption treatment found for `identity_verifications.id_reference_number` — relies on RLS + private storage bucket only | Medium — inconsistent protection tier vs. the bank-number case above, for data that is arguably equally sensitive |
| Encryption at rest/in transit (database, storage) | **NOT VERIFIABLE FROM CODE** | Supabase-managed infrastructure setting | — |

## ASVS V14 — Configuration / Dependency Management

| Control | Status | Evidence | Risk if gap |
|---|---|---|---|
| Dependency freshness | **VERIFIED, current** | Next 16.3.5, React 19.2.4, `@supabase/supabase-js` ^2.108.1 — current major versions as of this audit | — |
| Lockfile committed | **VERIFIED** | `package-lock.json` present at repo root | — |
| Automated dependency-update bot | **ABSENT** | No `.github/dependabot.yml` or Renovate config found | Low-Medium — updates are manual-only going forward |

## POPIA-specific notes (not a legal opinion — flagging code-observable facts relevant to counsel's review)

- **Condition 1 (Accountability) / Condition 8 (Security safeguards):** the admin-read-logging gap and the lack of external alerting are the two findings most directly relevant here — an organization's ability to demonstrate who accessed sensitive personal information, and to detect a breach promptly, are both currently weaker than the mutation-logging and webhook-integrity findings elsewhere in this matrix.
- **Condition 5 (Further processing)/consent:** the missing cookie-consent banner (Doc B §3) is a process gap even though no third-party ad platform exists today to misuse that data.
- **Breach notification process:** No incident-response runbook or breach-notification procedure was found in `docs/`. This should be reviewed with counsel — not something code review alone can resolve.

## Explicitly NOT VERIFIED (would require live access)

- Supabase dashboard MFA-enforcement setting for admin accounts.
- Supabase Auth dashboard password-policy configuration.
- Production WAF / bot-protection service (e.g. Cloudflare, Vercel's own bot-management) — not visible from this repo.
- Any security-incident history.
- Any penetration-test report.
- Precise values of `ALLOWED_PHOTO_MIME_TYPES`/`MAX_PHOTO_SIZE_BYTES` in `src/lib/listings/validation.ts` (referenced, not independently re-opened in this pass).
- Exact numeric rate-limit thresholds on the specific login/payment/admin-mutation routes (not individually re-verified beyond confirming the mechanism itself works).
