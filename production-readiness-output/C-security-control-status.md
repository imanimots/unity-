# C — Security-Control Status

| Control | Implementation status | Verification status |
|---|---|---|
| Admin MFA | **Implemented** (code complete, feature-flagged, `src/lib/supabase/admin-mfa.ts` + `require-admin.ts`) | **Verified in development**: 7 new unit tests pass; a live authenticated-smoke E2E rerun confirms the default-off state introduces zero regression to real admin login. **Not verified in production** — the flag has never been set to `true` against real admin accounts, and must not be until the rollout checklist (`docs/operations/ADMIN_MFA_ROLLOUT_CHECKLIST.md`) is complete |
| Malware scanning | **Not implemented** (deliberately — no placeholder scanning built) | N/A — a provider comparison + exact integration spec exists (`MALWARE_SCANNING_PROVIDER_SPEC.md`) for whoever provisions a vendor |
| Error monitoring | **Not implemented** (deliberately, same reasoning) | N/A — integration spec exists (`MONITORING_INTEGRATION_SPEC.md`) |
| Admin sensitive-data-read access logging (KYC documents) | **Implemented** (prior session) | **Verified in code/tests** (7 tests); **not yet verified in production** — the underlying table does not exist on the live database yet (migration unmerged, confirmed via a live `PGRST205` error this session) |
| Row-Level Security (general) | **Implemented** (pre-existing, unchanged) | **Verified live, this session**: 5/6 `rls-negative-access.spec.ts` tests pass against the real database (1 skipped for data-availability, not failure) |
| Permissions / role-based access (`requireAdmin`/`requireMerchant`/`requireAuth`) | **Implemented** (pre-existing) | **Verified live, this session** via `route-protection.spec.ts` (6/6 pass) and the authenticated-smoke suite |

## Net change this session

One control (admin MFA) moved from "not implemented" to "implemented and verified in development, pending a supervised production rollout." No control regressed. Two controls (malware scanning, error monitoring) remain correctly unimplemented rather than faked.
